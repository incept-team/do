import { createSlackAdapter } from "@chat-adapter/slack"
import * as errors from "@superbuilders/errors"
import * as logger from "@superbuilders/slog"
import type { Attachment } from "chat"
import {
	Actions,
	type Author,
	Button,
	Card,
	CardText,
	Chat,
	Modal,
	type ModalElement,
	RadioSelect,
	Select,
	SelectOption,
	TextInput,
	type Thread,
	ThreadImpl
} from "chat"
import { eq } from "drizzle-orm"
import { db } from "@/db"
import { cursorAgentThreads } from "@/db/schemas/cursor"
import { env } from "@/env"
import { inngest } from "@/inngest"
import { createCursorClient } from "@/lib/clients/cursor/client"
import { composeWorkflowPrompt } from "@/lib/prompt-compose"
import { dequeue, ErrQueueFull, enqueue, MAX_QUEUE_SIZE, pendingCount } from "@/lib/queue"
import type { CursorImage } from "@/lib/slack-images"
import { extractAttachments, parseCursorImages } from "@/lib/slack-images"
import { createPostgresState } from "@/lib/state-postgres"

const DEFAULT_REPOSITORY = "incept-team/incept"
const DEFAULT_REF = "main"

const CHANNEL_REPOS: Record<string, { repository: string; ref: string }> = {
	C0AHSQHA5A4: { repository: DEFAULT_REPOSITORY, ref: DEFAULT_REF }
}

const bot = new Chat({
	userName: "cursor-bot",
	adapters: {
		slack: createSlackAdapter()
	},
	state: createPostgresState()
}).registerSingleton()

bot.onNewMention(async (thread, message) => {
	const result = await errors.try(handleNewMention(thread, message))
	if (result.error) {
		logger.error("onNewMention failed", { error: result.error, threadId: thread.id })
		await postError(thread, result.error)
	}
})

bot.onSubscribedMessage(async (thread, message) => {
	const result = await errors.try(handleSubscribedMessage(thread, message))
	if (result.error) {
		logger.error("onSubscribedMessage failed", { error: result.error, threadId: thread.id })
		await postError(thread, result.error)
	}
})

bot.onAction("cursor-stop-and-followup", async (event) => {
	const result = await errors.try(handleStopAndFollowup(event.thread, event.threadId))
	if (result.error) {
		logger.error("stop-and-followup action failed", {
			error: result.error,
			threadId: event.threadId
		})
		await postError(event.thread, result.error)
	}
})

bot.onAction("cursor-cancel-followup", async (event) => {
	const result = await errors.try(handleCancelFollowup(event.thread, event.threadId))
	if (result.error) {
		logger.error("cancel-followup action failed", {
			error: result.error,
			threadId: event.threadId
		})
		await postError(event.thread, result.error)
	}
})

bot.onAction("cursor-queue", async (event) => {
	const result = await errors.try(
		handleQueue(event.thread, event.threadId, event.user, event.messageId)
	)
	if (result.error) {
		logger.error("queue action failed", { error: result.error, threadId: event.threadId })
		await postError(event.thread, result.error)
	}
})

bot.onAction("cursor-dequeue", async (event) => {
	const result = await errors.try(
		handleDequeue(event.thread, event.threadId, event.user, event.value)
	)
	if (result.error) {
		logger.error("dequeue action failed", { error: result.error, threadId: event.threadId })
		await postError(event.thread, result.error)
	}
})

bot.onSlashCommand("/do", async (event) => {
	const result = await errors.try(handleCursorCommand(event))
	if (result.error) {
		logger.error("slash command failed", { error: result.error })
		await event.channel.postEphemeral(event.user, `*Error:* \`${result.error.message}\``, {
			fallbackToDM: false
		})
	}
})

bot.onModalSubmit("cursor_launch_form", async (event) => {
	const result = await errors.try(handleLaunchFormSubmit(event))
	if (result.error) {
		logger.error("launch form submit failed", { error: result.error })
		return {
			action: "errors" as const,
			errors: { prompt: `Launch failed: ${result.error.message}` }
		}
	}
	return result.data
})

async function postError(thread: Thread<unknown>, err: Error): Promise<void> {
	const postResult = await errors.try(thread.post(`*Error:* \`${err.message}\``))
	if (postResult.error) {
		logger.error("failed to post error to thread", { error: postResult.error })
	}
}

async function postWarnings(thread: Thread<unknown>, warnings: string[]): Promise<void> {
	if (warnings.length === 0) return
	const text = warnings.map((w) => `> ${w}`).join("\n")
	const postResult = await errors.try(thread.post(text))
	if (postResult.error) {
		logger.warn("failed to post image warnings", { error: postResult.error })
	}
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text
	return `${text.slice(0, maxLength - 3)}...`
}

async function reactToMessage(
	thread: Thread<unknown>,
	messageId: string,
	emoji: string,
	action: "add" | "remove"
): Promise<void> {
	const fn = action === "add" ? thread.adapter.addReaction : thread.adapter.removeReaction
	const result = await errors.try(fn.call(thread.adapter, thread.id, messageId, emoji))
	if (result.error) {
		logger.warn("failed to update reaction", { action, emoji, error: result.error })
	}
}

type IncomingMessage = {
	id: string
	text: string
	attachments: Attachment[]
	author: {
		userId: string
		userName: string
		fullName: string
		isBot: boolean | "unknown"
		isMe: boolean
	}
}

const BOT_USER_ID = "U0AGS2FM1NX"
const BOT_MENTION_PATTERN = new RegExp(`^@${BOT_USER_ID}`)
const USER_MENTION_PATTERN = /@(?!here\b|channel\b|everyone\b)\S+/g

async function handleNewMention(thread: Thread, message: IncomingMessage): Promise<void> {
	if (!BOT_MENTION_PATTERN.test(message.text)) {
		logger.debug("ignoring non-leading mention", { threadId: thread.id })
		return
	}

	const prompt = message.text.replace(new RegExp(`@${BOT_USER_ID}`, "g"), "@Cursor").trim()
	if (!prompt) {
		await thread.post("Give me a task and I'll launch a Cursor agent for it.")
		return
	}

	const config = CHANNEL_REPOS[thread.channelId]
	if (!config) {
		await thread.post(`No repo configured for this channel (\`${thread.channelId}\`).`)
		return
	}

	await thread.subscribe()

	const reactResult = await errors.try(
		thread.adapter.addReaction(thread.id, message.id, "one-sec-cooking")
	)
	if (reactResult.error) {
		logger.warn("failed to react to mention", { error: reactResult.error })
	}

	const { images, fileContents, warnings } = await extractAttachments(message.attachments)
	await postWarnings(thread, warnings)

	const enrichedPrompt = fileContents ? `${fileContents}\n\n${prompt}` : prompt

	const composedPrompt = await composeWorkflowPrompt(
		config.repository,
		enrichedPrompt,
		message.author.userId
	)

	await inngest.send({
		name: "cursor/agent.launch",
		data: {
			prompt: composedPrompt,
			repository: config.repository,
			ref: config.ref,
			threadId: thread.id,
			images
		}
	})
}

function isDirectedElsewhere(text: string): boolean {
	const mentions = text.match(USER_MENTION_PATTERN)
	if (!mentions) return false
	return !mentions.some((m) => m === `@${BOT_USER_ID}`)
}

async function handleSubscribedMessage(thread: Thread, message: IncomingMessage): Promise<void> {
	if (isDirectedElsewhere(message.text)) {
		logger.debug("ignoring message directed at others", { threadId: thread.id })
		return
	}

	const followupText = message.text.replace(new RegExp(`@${BOT_USER_ID}`, "g"), "@Cursor").trim()
	if (!followupText) {
		return
	}

	logger.debug("subscribed message received", { threadId: thread.id, text: followupText })

	await reactToMessage(thread, message.id, "see_no_evil", "add")

	const { images, fileContents, warnings } = await extractAttachments(message.attachments)
	await postWarnings(thread, warnings)

	const enrichedFollowup = fileContents ? `${fileContents}\n\n${followupText}` : followupText

	const rows = await db
		.select({
			agentId: cursorAgentThreads.agentId,
			status: cursorAgentThreads.status,
			agentUrl: cursorAgentThreads.agentUrl
		})
		.from(cursorAgentThreads)
		.where(eq(cursorAgentThreads.threadId, thread.id))

	const row = rows[0]
	if (!row) {
		logger.warn("no agent found for subscribed thread", { threadId: thread.id })
		await reactToMessage(thread, message.id, "see_no_evil", "remove")
		return
	}

	const apiKey = env.CURSOR_API_KEY
	if (!apiKey) {
		await reactToMessage(thread, message.id, "see_no_evil", "remove")
		logger.error("missing CURSOR_API_KEY for followup")
		throw errors.new("CURSOR_API_KEY not configured")
	}

	if (row.status === "RUNNING" || row.status === "CREATING") {
		const followupImages = images.length > 0 ? images : null
		await db
			.update(cursorAgentThreads)
			.set({
				pendingFollowup: enrichedFollowup,
				pendingFollowupImages: followupImages
			})
			.where(eq(cursorAgentThreads.threadId, thread.id))

		const queueCount = await pendingCount(thread.id)
		const queueIsFull = queueCount >= MAX_QUEUE_SIZE

		const stopButton = Button({
			id: "cursor-stop-and-followup",
			label: "Stop & Send Now",
			style: "danger"
		})
		const cancelButton = Button({
			id: "cursor-cancel-followup",
			label: "Cancel"
		})

		const buttons = queueIsFull
			? [stopButton, cancelButton]
			: [
					Button({
						id: "cursor-queue",
						label: `Queue This (#${queueCount + 1} in line)`,
						style: "primary"
					}),
					stopButton,
					cancelButton
				]

		const cardText = queueIsFull
			? `The agent is still running. Queue is full (${MAX_QUEUE_SIZE}/${MAX_QUEUE_SIZE}).`
			: "The agent is still running. You can queue this message or stop the agent."

		const card = Card({
			children: [CardText(cardText), Actions(buttons)]
		})

		await thread.postEphemeral(message.author, card, { fallbackToDM: false })
		await reactToMessage(thread, message.id, "see_no_evil", "remove")
		return
	}

	await sendFollowup(apiKey, row.agentId, enrichedFollowup, images)

	await inngest.send({
		name: "cursor/followup.sent",
		data: { agentId: row.agentId, threadId: thread.id, agentUrl: row.agentUrl }
	})

	await reactToMessage(thread, message.id, "see_no_evil", "remove")

	await thread.post(
		"*Follow-up sent*\n\nYour follow-up has been sent to the agent. Waiting for a response..."
	)
	logger.info("followup sent", { agentId: row.agentId, threadId: thread.id })
}

async function handleStopAndFollowup(thread: Thread<unknown>, threadId: string): Promise<void> {
	logger.info("stop and followup action", { threadId })

	const rows = await db
		.select({
			agentId: cursorAgentThreads.agentId,
			agentUrl: cursorAgentThreads.agentUrl,
			pendingFollowup: cursorAgentThreads.pendingFollowup,
			pendingFollowupImages: cursorAgentThreads.pendingFollowupImages
		})
		.from(cursorAgentThreads)
		.where(eq(cursorAgentThreads.threadId, threadId))

	const row = rows[0]
	if (!row) {
		logger.error("no agent found for action", { threadId })
		throw errors.new("no agent found for this thread")
	}

	if (!row.pendingFollowup) {
		logger.error("no pending followup", { threadId })
		throw errors.new("no pending follow-up message found")
	}

	const apiKey = env.CURSOR_API_KEY
	if (!apiKey) {
		logger.error("missing CURSOR_API_KEY for stop+followup")
		throw errors.new("CURSOR_API_KEY not configured")
	}

	const client = createCursorClient(apiKey)

	const stopResponse = await client.POST("/v0/agents/{id}/stop", {
		params: { path: { id: row.agentId } }
	})

	if (stopResponse.error) {
		const detail = JSON.stringify(stopResponse.error)
		logger.error("failed to stop agent", { error: detail, agentId: row.agentId })
		throw errors.new(`cursor stop API: ${detail}`)
	}

	logger.info("agent stopped", { agentId: row.agentId })

	const pendingImages = parseCursorImages(row.pendingFollowupImages)
	await sendFollowup(apiKey, row.agentId, row.pendingFollowup, pendingImages)

	await db
		.update(cursorAgentThreads)
		.set({ pendingFollowup: null, pendingFollowupImages: null })
		.where(eq(cursorAgentThreads.threadId, threadId))

	await inngest.send({
		name: "cursor/followup.sent",
		data: { agentId: row.agentId, threadId, agentUrl: row.agentUrl }
	})

	await thread.post(
		"*Follow-up sent*\n\nAgent stopped and follow-up sent. Waiting for a response..."
	)
	logger.info("stop and followup complete", { agentId: row.agentId })
}

async function handleCancelFollowup(thread: Thread<unknown>, threadId: string): Promise<void> {
	logger.debug("cancel followup action", { threadId })

	await db
		.update(cursorAgentThreads)
		.set({ pendingFollowup: null, pendingFollowupImages: null })
		.where(eq(cursorAgentThreads.threadId, threadId))

	await thread.post("Cancelled.")
}

async function handleQueue(
	thread: Thread<unknown>,
	threadId: string,
	user: Author,
	messageId: string
): Promise<void> {
	logger.info("queue action", { threadId, userId: user.userId })

	const rows = await db
		.select({
			pendingFollowup: cursorAgentThreads.pendingFollowup,
			repository: cursorAgentThreads.repository
		})
		.from(cursorAgentThreads)
		.where(eq(cursorAgentThreads.threadId, threadId))

	const row = rows[0]
	if (!row) {
		logger.error("no agent found for queue action", { threadId })
		throw errors.new("no agent found for this thread")
	}

	if (!row.pendingFollowup) {
		logger.error("no pending followup for queue action", { threadId })
		throw errors.new("no pending follow-up message found")
	}

	const config = CHANNEL_REPOS[thread.channelId]
	if (!config) {
		logger.error("no repo configured for channel", { channelId: thread.channelId })
		throw errors.new("no repo configured for this channel")
	}

	const composedPrompt = await composeWorkflowPrompt(
		config.repository,
		row.pendingFollowup,
		user.userId
	)

	const enqueueResult = await errors.try(
		enqueue({
			threadId,
			prompt: composedPrompt,
			rawMessage: row.pendingFollowup,
			slackUserId: user.userId,
			messageId
		})
	)
	if (enqueueResult.error) {
		if (errors.is(enqueueResult.error, ErrQueueFull)) {
			const fullCard = Card({
				children: [
					CardText(`Queue is full (${MAX_QUEUE_SIZE}/${MAX_QUEUE_SIZE}). Try again later.`)
				]
			})
			await thread.postEphemeral(user, fullCard, { fallbackToDM: false })
			return
		}
		logger.error("enqueue failed", { error: enqueueResult.error, threadId })
		throw errors.wrap(enqueueResult.error, "enqueue")
	}

	await db
		.update(cursorAgentThreads)
		.set({ pendingFollowup: null, pendingFollowupImages: null })
		.where(eq(cursorAgentThreads.threadId, threadId))

	await reactToMessage(thread, messageId, "hourglass_flowing_sand", "add")

	const position = enqueueResult.data.position
	const itemId = enqueueResult.data.id

	const queuedCard = Card({
		children: [
			CardText(`Queued at position #${position}.`),
			Actions([
				Button({
					id: "cursor-dequeue",
					label: "Remove from Queue",
					style: "danger",
					value: String(itemId)
				})
			])
		]
	})

	await thread.postEphemeral(user, queuedCard, { fallbackToDM: false })
	logger.info("message queued", { threadId, position, itemId })
}

async function handleDequeue(
	thread: Thread<unknown>,
	threadId: string,
	user: Author,
	value: string | undefined
): Promise<void> {
	logger.info("dequeue action", { threadId, value })

	if (!value) {
		logger.error("dequeue action missing value", { threadId })
		throw errors.new("missing queue item id")
	}

	const itemId = Number.parseInt(value, 10)
	if (Number.isNaN(itemId)) {
		logger.error("dequeue action invalid value", { threadId, value })
		throw errors.new("invalid queue item id")
	}

	const item = await dequeue(itemId)
	if (!item) {
		const goneCard = Card({
			children: [CardText("Item was already removed or processed.")]
		})
		await thread.postEphemeral(user, goneCard, { fallbackToDM: false })
		return
	}

	if (item.messageId) {
		await reactToMessage(thread, item.messageId, "hourglass_flowing_sand", "remove")
	}

	const removedCard = Card({
		children: [CardText("Removed from queue.")]
	})
	await thread.postEphemeral(user, removedCard, { fallbackToDM: false })
	logger.info("item dequeued", { threadId, itemId })
}

async function sendFollowup(
	apiKey: string,
	agentId: string,
	text: string,
	images: CursorImage[]
): Promise<void> {
	const client = createCursorClient(apiKey)
	const promptBody = images.length > 0 ? { text, images } : { text }
	const { error } = await client.POST("/v0/agents/{id}/followup", {
		params: { path: { id: agentId } },
		body: { prompt: promptBody }
	})

	if (error) {
		const detail = JSON.stringify(error)
		logger.error("cursor followup api error", { error: detail, agentId })
		throw errors.new(`cursor followup API: ${detail}`)
	}
}

async function handleCursorCommand(event: {
	text: string
	user: Author
	channel: {
		id: string
		postEphemeral: (user: Author, msg: string, opts: { fallbackToDM: boolean }) => Promise<unknown>
	}
	openModal: (modal: ModalElement) => Promise<{ viewId: string } | undefined>
}): Promise<void> {
	logger.info("do slash command", { userId: event.user.userId, text: event.text })

	const models = await fetchModels()

	const channelConfig = CHANNEL_REPOS[event.channel.id]
	const prefilledRepo = channelConfig ? channelConfig.repository : "incept-team/incept"
	const prefilledRef = channelConfig ? channelConfig.ref : DEFAULT_REF
	const prefilledPrompt = event.text.trim()

	const modelOptions = [
		SelectOption({ label: "Let Cursor choose", value: "__auto__" }),
		...models.map(function toOption(m: string) {
			return SelectOption({ label: m, value: m })
		})
	]

	const modal = Modal({
		callbackId: "cursor_launch_form",
		title: "Launch Agent",
		submitLabel: "Launch",
		closeLabel: "Cancel",
		privateMetadata: JSON.stringify({ channelId: event.channel.id }),
		children: [
			TextInput({
				id: "prompt",
				label: "Task",
				placeholder: "Describe what the agent should do...",
				multiline: true,
				...(prefilledPrompt ? { initialValue: prefilledPrompt } : {})
			}),
			Select({
				id: "model",
				label: "Model",
				optional: true,
				initialOption: "__auto__",
				options: modelOptions
			}),
			TextInput({
				id: "repository",
				label: "Repository",
				placeholder: "owner/repo",
				optional: true,
				...(prefilledRepo ? { initialValue: prefilledRepo } : {})
			}),
			TextInput({
				id: "ref",
				label: "Base Branch",
				placeholder: "main",
				optional: true,
				...(prefilledRef ? { initialValue: prefilledRef } : {})
			}),
			TextInput({
				id: "branchName",
				label: "Custom Branch Name",
				placeholder: "feature/my-branch (optional)",
				optional: true
			}),
			RadioSelect({
				id: "pipelineMode",
				label: "Pipeline Mode",
				initialOption: "cursor",
				options: [
					SelectOption({
						label: "Quick (Cursor Agent)",
						value: "cursor",
						description: "Single Cursor agent — fast for small tasks"
					}),
					SelectOption({
						label: "Autonomous Pipeline",
						value: "autonomous",
						description: "Full pipeline: analyze → design → judge → implement → PR → CI fix"
					}),
					SelectOption({
						label: "Supervised Pipeline",
						value: "supervised",
						description: "Full pipeline with human approval gates between phases"
					})
				]
			}),
			RadioSelect({
				id: "autoCreatePr",
				label: "Auto-Create PR",
				initialOption: "true",
				options: [
					SelectOption({
						label: "Yes",
						value: "true",
						description: "Create a PR when agent finishes"
					}),
					SelectOption({ label: "No", value: "false" })
				]
			}),
			RadioSelect({
				id: "openAsCursorGithubApp",
				label: "Open PR as Cursor App",
				initialOption: "false",
				optional: true,
				options: [
					SelectOption({
						label: "Yes",
						value: "true",
						description: "PR opened by Cursor GitHub App"
					}),
					SelectOption({ label: "No", value: "false" })
				]
			}),
			RadioSelect({
				id: "skipReviewerRequest",
				label: "Skip Reviewer Request",
				initialOption: "false",
				optional: true,
				options: [
					SelectOption({ label: "Yes", value: "true", description: "Don't add you as reviewer" }),
					SelectOption({ label: "No", value: "false" })
				]
			})
		]
	})

	const openResult = await event.openModal(modal)
	if (!openResult) {
		logger.error("failed to open launch modal")
		await event.channel.postEphemeral(
			event.user,
			"Couldn't open the launch form. Please try again.",
			{ fallbackToDM: false }
		)
	}
}

type ModalFormErrors = { action: "errors"; errors: Record<string, string> }
type ValidatedLaunchForm = { prompt: string; repository: string }

const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

function validateLaunchForm(values: Record<string, string>): ModalFormErrors | ValidatedLaunchForm {
	const { prompt, repository } = values

	if (!prompt || prompt.trim().length === 0) {
		return { action: "errors", errors: { prompt: "Task description is required" } }
	}

	const resolvedRepo =
		repository && repository.trim().length > 0 ? repository.trim() : DEFAULT_REPOSITORY

	if (!REPO_PATTERN.test(resolvedRepo)) {
		return { action: "errors", errors: { repository: "Must be owner/repo format" } }
	}

	return { prompt: prompt.trim(), repository: resolvedRepo }
}

function isFormErrors(result: ModalFormErrors | ValidatedLaunchForm): result is ModalFormErrors {
	return "action" in result
}

function resolveLaunchFields(values: Record<string, string>): {
	model: string | undefined
	branchName: string | undefined
	ref: string
	autoCreatePr: boolean | undefined
	openAsCursorGithubApp: boolean | undefined
	skipReviewerRequest: boolean | undefined
	pipelineMode: "cursor" | "autonomous" | "supervised"
} {
	const resolvedModel = values.model && values.model !== "__auto__" ? values.model : undefined
	const resolvedBranch = values.branchName?.trim() ? values.branchName.trim() : undefined
	const resolvedRef = values.ref?.trim() ? values.ref.trim() : DEFAULT_REF
	const resolvedAutoCreatePr = values.autoCreatePr ? values.autoCreatePr === "true" : undefined
	const resolvedOpenAs = values.openAsCursorGithubApp
		? values.openAsCursorGithubApp === "true"
		: undefined
	const resolvedSkip = values.skipReviewerRequest
		? values.skipReviewerRequest === "true"
		: undefined
	const pipelineMode =
		values.pipelineMode === "autonomous"
			? ("autonomous" as const)
			: values.pipelineMode === "supervised"
				? ("supervised" as const)
				: ("cursor" as const)

	return {
		model: resolvedModel,
		branchName: resolvedBranch,
		ref: resolvedRef,
		autoCreatePr: resolvedAutoCreatePr,
		openAsCursorGithubApp: resolvedOpenAs,
		skipReviewerRequest: resolvedSkip,
		pipelineMode
	}
}

function buildModeLabel(mode: "cursor" | "autonomous" | "supervised"): string {
	if (mode === "autonomous") return " *(autonomous pipeline)*"
	if (mode === "supervised") return " *(supervised pipeline)*"
	return ""
}

async function launchPipeline(ctx: {
	prompt: string
	repository: string
	ref: string
	pipelineMode: "autonomous" | "supervised"
	threadId: string
	messageId: string
	userId: string
}): Promise<ModalFormErrors | undefined> {
	const githubRepoUrl = `https://github.com/${ctx.repository}`
	const sendResult = await errors.try(
		inngest.send({
			name: "paul/pipeline/feature-run",
			data: {
				prompt: ctx.prompt,
				githubRepoUrl,
				githubBranch: ctx.ref,
				runtime: "node24" as const,
				mode: ctx.pipelineMode,
				slackThreadId: ctx.threadId,
				slackMessageId: ctx.messageId
			}
		})
	)
	if (sendResult.error) {
		logger.error("failed to send pipeline event", { error: sendResult.error })
		return { action: "errors", errors: { prompt: "Failed to launch pipeline. Try again." } }
	}

	logger.info("pipeline launched from modal", {
		userId: ctx.userId,
		repository: ctx.repository,
		mode: ctx.pipelineMode,
		threadId: ctx.threadId
	})

	return undefined
}

async function handleLaunchFormSubmit(event: {
	values: Record<string, string>
	user: Author
	privateMetadata?: string
	relatedChannel?: {
		id: string
		post: (
			msg: string
		) => Promise<{ id: string; threadId: string; addReaction: (emoji: string) => Promise<void> }>
	}
}): Promise<ModalFormErrors | undefined> {
	const validated = validateLaunchForm(event.values)
	if (isFormErrors(validated)) return validated

	const { prompt, repository } = validated
	const resolved = resolveLaunchFields(event.values)

	if (!event.relatedChannel) {
		logger.error("no related channel on modal submit")
		return { action: "errors", errors: { prompt: "Could not determine channel. Try again." } }
	}

	const isPipeline =
		resolved.pipelineMode === "autonomous" ? true : resolved.pipelineMode === "supervised"

	const composedPrompt = isPipeline
		? prompt
		: await composeWorkflowPrompt(repository, prompt, event.user.userId)

	const modeLabel = buildModeLabel(resolved.pipelineMode)
	const modelLabel = resolved.model ? ` (${resolved.model})` : ""
	const branchLabel = resolved.branchName ? ` → \`${resolved.branchName}\`` : ""
	const confirmationText = `*Launching${modeLabel}*${modelLabel} on \`${repository}\`${branchLabel}\n\n_"${truncate(prompt, 200)}"_`

	const postResult = await errors.try(event.relatedChannel.post(confirmationText))
	if (postResult.error) {
		logger.error("failed to post launch message", { error: postResult.error })
		return { action: "errors", errors: { prompt: "Failed to post to channel. Try again." } }
	}

	const sentMessage = postResult.data
	const threadId = `${event.relatedChannel.id}:${sentMessage.id}`

	const t = thread(threadId)
	await t.subscribe()

	const reactResult = await errors.try(sentMessage.addReaction("one-sec-cooking"))
	if (reactResult.error) {
		logger.warn("failed to react to launch message", { error: reactResult.error })
	}

	if (isPipeline) {
		const pipelineMode =
			resolved.pipelineMode === "autonomous" ? ("autonomous" as const) : ("supervised" as const)
		return launchPipeline({
			prompt: composedPrompt,
			repository,
			ref: resolved.ref,
			pipelineMode,
			threadId,
			messageId: sentMessage.id,
			userId: event.user.userId
		})
	}

	const sendResult = await errors.try(
		inngest.send({
			name: "cursor/agent.launch",
			data: {
				prompt: composedPrompt,
				repository,
				ref: resolved.ref,
				threadId,
				images: [],
				model: resolved.model,
				branchName: resolved.branchName,
				autoCreatePr: resolved.autoCreatePr,
				openAsCursorGithubApp: resolved.openAsCursorGithubApp,
				skipReviewerRequest: resolved.skipReviewerRequest
			}
		})
	)
	if (sendResult.error) {
		logger.error("failed to send inngest event", { error: sendResult.error })
		return { action: "errors", errors: { prompt: "Failed to launch agent. Please try again." } }
	}

	const modelLog = resolved.model ? resolved.model : "auto"
	logger.info("agent launched from modal", {
		userId: event.user.userId,
		repository,
		model: modelLog,
		threadId
	})

	return undefined
}

async function fetchModels(): Promise<string[]> {
	const apiKey = env.CURSOR_API_KEY
	if (!apiKey) {
		logger.warn("CURSOR_API_KEY not set, returning empty model list")
		return []
	}

	const client = createCursorClient(apiKey)
	const { data, error } = await client.GET("/v0/models")
	if (error) {
		logger.warn("failed to fetch cursor models", { error: JSON.stringify(error) })
		return []
	}

	return data.models
}

function thread(threadId: string): Thread {
	const firstColon = threadId.indexOf(":")
	if (firstColon === -1) {
		logger.error("invalid thread id format", { threadId })
		throw errors.new("invalid thread id format, expected adapter:channel:ts")
	}
	const adapterName = threadId.slice(0, firstColon)
	const secondColon = threadId.indexOf(":", firstColon + 1)
	if (secondColon === -1) {
		logger.error("invalid thread id format", { threadId })
		throw errors.new("invalid thread id format, expected adapter:channel:ts")
	}
	const channelId = threadId.slice(0, secondColon)
	return new ThreadImpl({
		adapterName,
		channelId,
		id: threadId
	})
}

export { CHANNEL_REPOS, bot, thread }
