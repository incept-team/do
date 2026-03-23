import * as errors from "@superbuilders/errors"
import * as logger from "@superbuilders/slog"
import { ThreadImpl } from "chat"

type PhaseStatus =
	| "received"
	| "analysis"
	| "approaches"
	| "judging"
	| "implementation"
	| "pr_created"
	| "ci_fixing"
	| "complete"
	| "failed"

const PHASE_EMOJI: Record<PhaseStatus, string> = {
	received: "one-sec-cooking",
	analysis: "mag",
	approaches: "art",
	judging: "scales",
	implementation: "hammer_and_wrench",
	pr_created: "rocket",
	ci_fixing: "wrench",
	complete: "white_check_mark",
	failed: "x"
}

const PHASE_LABEL: Record<PhaseStatus, string> = {
	received: "Received",
	analysis: "Analyzing codebase",
	approaches: "Generating design proposals",
	judging: "Evaluating approaches",
	implementation: "Implementing",
	pr_created: "PR created",
	ci_fixing: "Fixing CI failures",
	complete: "Complete",
	failed: "Failed"
}

function resolveThread(threadId: string): ThreadImpl {
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
	return new ThreadImpl({ adapterName, channelId, id: threadId })
}

async function addReaction(threadId: string, messageId: string, emoji: string): Promise<void> {
	const t = resolveThread(threadId)
	const result = await errors.try(t.adapter.addReaction(t.id, messageId, emoji))
	if (result.error) {
		logger.warn("failed to add reaction", { emoji, error: result.error })
	}
}

async function removeReaction(threadId: string, messageId: string, emoji: string): Promise<void> {
	const t = resolveThread(threadId)
	const result = await errors.try(t.adapter.removeReaction(t.id, messageId, emoji))
	if (result.error) {
		logger.warn("failed to remove reaction", { emoji, error: result.error })
	}
}

async function postPhaseUpdate(
	threadId: string,
	phase: PhaseStatus,
	detail: string
): Promise<void> {
	const t = resolveThread(threadId)
	const emoji = PHASE_EMOJI[phase]
	const label = PHASE_LABEL[phase]
	const message = `:${emoji}: *${label}*\n\n${detail}`
	const result = await errors.try(t.post(message))
	if (result.error) {
		logger.warn("failed to post phase update", { phase, error: result.error })
	}
}

async function transitionPhase(ctx: {
	threadId: string
	messageId: string
	previousPhase: PhaseStatus | undefined
	newPhase: PhaseStatus
	detail: string
}): Promise<void> {
	if (ctx.previousPhase) {
		await removeReaction(ctx.threadId, ctx.messageId, PHASE_EMOJI[ctx.previousPhase])
	}
	await addReaction(ctx.threadId, ctx.messageId, PHASE_EMOJI[ctx.newPhase])
	await postPhaseUpdate(ctx.threadId, ctx.newPhase, ctx.detail)
}

export { PHASE_EMOJI, PHASE_LABEL, addReaction, postPhaseUpdate, removeReaction, transitionPhase }
export type { PhaseStatus }
