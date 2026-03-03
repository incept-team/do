import * as errors from "@superbuilders/errors"
import type { Thread } from "chat"
import { eq } from "drizzle-orm"
import type { Logger } from "inngest"
import { NonRetriableError } from "inngest"
import { z } from "zod"
import { db } from "@/db"
import { cursorAgentThreads } from "@/db/schemas/cursor"
import { env } from "@/env"
import { inngest } from "@/inngest"
import { thread } from "@/lib/bot"

const SLEEP_DURATION = "10m"
const MAX_CYCLES = 5

const GitHubCommitSchema = z.object({
	sha: z.string().min(1)
})

function parseOwnerRepo(repository: string, logger: Logger): { owner: string; repo: string } {
	const parts = repository.split("/")
	const owner = parts[0]
	const repo = parts[1]

	if (!owner || !repo) {
		logger.error("invalid repository format", { repository })
		throw new NonRetriableError(`invalid repository format: ${repository}`)
	}

	return { owner, repo }
}

function buildSlackLinks(prUrl: string | undefined, agentUrl: string): string {
	const links: string[] = []
	if (prUrl) {
		links.push(`<${prUrl}|View PR>`)
	}
	links.push(`<${agentUrl}|View in Cursor>`)
	return links.join(" \u00b7 ")
}

async function postToThread(
	t: Thread,
	message: string,
	logger: Logger,
	context: string
): Promise<void> {
	const result = await errors.try(t.post(message))
	if (result.error) {
		logger.error("failed to post to slack", { error: result.error, context })
		throw errors.wrap(result.error, context)
	}
}

async function getHeadSha(
	owner: string,
	repo: string,
	branch: string,
	token: string,
	logger: Logger
): Promise<string> {
	const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`

	const fetchResult = await errors.try(
		fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28"
			}
		})
	)
	if (fetchResult.error) {
		logger.error("github commit fetch failed", { error: fetchResult.error, owner, repo, branch })
		throw errors.wrap(fetchResult.error, "github commit fetch")
	}

	const response = fetchResult.data

	if (!response.ok) {
		const textResult = await errors.try(response.text())
		if (textResult.error) {
			logger.error("failed reading github error response", {
				error: textResult.error,
				status: response.status
			})
			throw errors.wrap(textResult.error, "github commit error response")
		}

		logger.error("github api returned error", {
			status: response.status,
			body: textResult.data
		})
		throw errors.new(`github commit api ${response.status}: ${textResult.data}`)
	}

	const jsonResult = await errors.try(response.json())
	if (jsonResult.error) {
		logger.error("failed parsing github commit json", { error: jsonResult.error })
		throw errors.wrap(jsonResult.error, "github commit response json")
	}

	const parsed = GitHubCommitSchema.safeParse(jsonResult.data)
	if (!parsed.success) {
		logger.error("invalid github commit response", { error: parsed.error })
		throw errors.wrap(parsed.error, "github commit response validation")
	}

	return parsed.data.sha
}

function parsePrNumber(prUrl: string, logger: Logger): number {
	const match = prUrl.match(/\/pull\/(\d+)$/)
	if (!match || !match[1]) {
		logger.error("failed to parse pr number from url", { prUrl })
		throw new NonRetriableError(`invalid pr url format: ${prUrl}`)
	}
	return Number.parseInt(match[1], 10)
}

type MergeOutcome = "merged" | "already_merged" | "not_mergeable"

const MergeResponseSchema = z.object({
	merged: z.boolean(),
	message: z.string()
})

async function mergePr(
	owner: string,
	repo: string,
	prNumber: number,
	token: string,
	logger: Logger
): Promise<MergeOutcome> {
	const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`

	const fetchResult = await errors.try(
		fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json"
			},
			body: JSON.stringify({ merge_method: "squash" })
		})
	)
	if (fetchResult.error) {
		logger.error("github merge fetch failed", { error: fetchResult.error, owner, repo, prNumber })
		throw errors.wrap(fetchResult.error, "github merge fetch")
	}

	const response = fetchResult.data

	if (response.status === 405) {
		logger.info("pr not mergeable", { owner, repo, prNumber, status: 405 })
		return "not_mergeable"
	}

	if (response.status === 404 || response.status === 409) {
		logger.info("pr already merged or closed", { owner, repo, prNumber, status: response.status })
		return "already_merged"
	}

	if (!response.ok) {
		const textResult = await errors.try(response.text())
		if (textResult.error) {
			logger.error("failed reading github merge error response", {
				error: textResult.error,
				status: response.status
			})
			throw errors.wrap(textResult.error, "github merge error response")
		}

		logger.error("github merge api returned error", {
			status: response.status,
			body: textResult.data
		})
		throw errors.new(`github merge api ${response.status}: ${textResult.data}`)
	}

	const jsonResult = await errors.try(response.json())
	if (jsonResult.error) {
		logger.error("failed parsing github merge json", { error: jsonResult.error })
		throw errors.wrap(jsonResult.error, "github merge response json")
	}

	const parsed = MergeResponseSchema.safeParse(jsonResult.data)
	if (!parsed.success) {
		logger.error("invalid github merge response", { error: parsed.error })
		throw errors.wrap(parsed.error, "github merge response validation")
	}

	if (!parsed.data.merged) {
		logger.warn("merge response says not merged", { message: parsed.data.message })
		return "not_mergeable"
	}

	return "merged"
}

type StabilizeParams = {
	owner: string
	repo: string
	repository: string
	branchName: string
	prUrl: string
	threadId: string
	agentUrl: string
	knownHeadSha: string | null
	cycle: number
}

async function resolveFromStabilizeEvent(
	d: {
		repository: string
		branchName: string
		prUrl: string
		threadId: string
		agentUrl: string
		headSha: string
		cycle: number
	},
	logger: Logger
): Promise<StabilizeParams> {
	const { owner, repo } = parseOwnerRepo(d.repository, logger)
	const knownHeadSha: string | null = d.headSha

	return {
		owner,
		repo,
		repository: d.repository,
		branchName: d.branchName,
		prUrl: d.prUrl,
		threadId: d.threadId,
		agentUrl: d.agentUrl,
		knownHeadSha,
		cycle: d.cycle
	}
}

async function resolveFromFinishedEvent(
	d: {
		agentId: string
		repository?: string
		branchName?: string
		prUrl: string
		agentUrl?: string
	},
	logger: Logger
): Promise<StabilizeParams> {
	const rows = await db
		.select({
			threadId: cursorAgentThreads.threadId,
			agentUrl: cursorAgentThreads.agentUrl
		})
		.from(cursorAgentThreads)
		.where(eq(cursorAgentThreads.agentId, d.agentId))
		.limit(1)

	const row = rows[0]
	if (!row) {
		logger.error("no thread found for agent", { agentId: d.agentId })
		throw new NonRetriableError(`no thread found for agent ${d.agentId}`)
	}

	if (!d.repository || !d.branchName) {
		logger.error("agent.finished missing required fields", {
			agentId: d.agentId,
			repository: d.repository,
			branchName: d.branchName
		})
		throw new NonRetriableError("agent.finished missing repository or branchName")
	}

	const agentUrl = d.agentUrl ? d.agentUrl : row.agentUrl
	if (!agentUrl) {
		logger.error("no agent url available", { agentId: d.agentId })
		throw new NonRetriableError("agent url not available from event or database")
	}

	const { owner, repo } = parseOwnerRepo(d.repository, logger)
	const knownHeadSha: string | null = null

	return {
		owner,
		repo,
		repository: d.repository,
		branchName: d.branchName,
		prUrl: d.prUrl,
		threadId: row.threadId,
		agentUrl,
		knownHeadSha,
		cycle: 1
	}
}

const prStabilize = inngest.createFunction(
	{ id: "cursor/pr-stabilize" },
	[
		{
			event: "cursor/agent.finished",
			if: "event.data.status == 'FINISHED' && event.data.prUrl != null"
		},
		{ event: "cursor/pr.stabilize" }
	],
	async ({ event, logger, step }) => {
		const token = env.GITHUB_PAT_TOKEN
		if (!token) {
			logger.error("missing GITHUB_PAT_TOKEN")
			throw new NonRetriableError("GITHUB_PAT_TOKEN not configured")
		}

		const params = await step.run("resolve-params", async () => {
			const d = event.data
			if ("cycle" in d) {
				return resolveFromStabilizeEvent(d, logger)
			}
			if (!d.prUrl) {
				logger.error("agent.finished missing prUrl", { agentId: d.agentId })
				throw new NonRetriableError("agent.finished missing prUrl")
			}
			return resolveFromFinishedEvent({ ...d, prUrl: d.prUrl }, logger)
		})

		const beforeSha = params.knownHeadSha
			? params.knownHeadSha
			: await step.run("get-head-commit", async () => {
					logger.info("fetching head sha", {
						owner: params.owner,
						repo: params.repo,
						branch: params.branchName,
						cycle: params.cycle
					})
					return getHeadSha(params.owner, params.repo, params.branchName, token, logger)
				})

		await step.sleep("wait-for-bugbot", SLEEP_DURATION)

		const afterSha = await step.run("check-for-new-commits", async () => {
			logger.info("fetching head sha after sleep", {
				owner: params.owner,
				repo: params.repo,
				branch: params.branchName,
				cycle: params.cycle
			})
			return getHeadSha(params.owner, params.repo, params.branchName, token, logger)
		})

		const isStable = beforeSha === afterSha

		if (!isStable && params.cycle >= MAX_CYCLES) {
			await step.run("post-gave-up", async () => {
				const t = thread(params.threadId)
				const linkLine = buildSlackLinks(params.prUrl, params.agentUrl)

				logger.warn("max stabilize cycles reached", {
					branch: params.branchName,
					cycle: params.cycle,
					beforeSha,
					afterSha
				})

				const message = [
					"*PR Still Receiving Commits*",
					"",
					`Branch \`${params.branchName}\` is still receiving commits after ${MAX_CYCLES * 10} minutes. Giving up on stabilization watch.`,
					"",
					linkLine
				].join("\n")

				await postToThread(t, message, logger, "post max-cycles message to slack")
			})

			return { branch: params.branchName, stable: false, merged: false, cycle: params.cycle }
		}

		if (!isStable) {
			await step.run("re-cycle", async () => {
				logger.info("new commits detected, re-cycling", {
					branch: params.branchName,
					beforeSha,
					afterSha,
					cycle: params.cycle,
					nextCycle: params.cycle + 1
				})

				const sendResult = await errors.try(
					inngest.send({
						name: "cursor/pr.stabilize",
						data: {
							repository: params.repository,
							branchName: params.branchName,
							prUrl: params.prUrl,
							threadId: params.threadId,
							agentUrl: params.agentUrl,
							headSha: afterSha,
							cycle: params.cycle + 1
						}
					})
				)
				if (sendResult.error) {
					logger.error("failed to emit stabilize event", { error: sendResult.error })
					throw errors.wrap(sendResult.error, "emit pr.stabilize event")
				}
			})

			return { branch: params.branchName, stable: false, merged: false, cycle: params.cycle }
		}

		await step.run("post-stable", async () => {
			const t = thread(params.threadId)
			const linkLine = buildSlackLinks(params.prUrl, params.agentUrl)

			logger.info("pr stable", { branch: params.branchName, sha: afterSha, cycle: params.cycle })

			const message = [
				"*PR Stable*",
				"",
				`No new commits on \`${params.branchName}\` in the last 10 minutes.`,
				"",
				linkLine
			].join("\n")

			await postToThread(t, message, logger, "post stable message to slack")
		})

		const prNumber = parsePrNumber(params.prUrl, logger)

		const mergeOutcome = await step.run("merge-pr", async () => {
			logger.info("attempting squash merge", {
				owner: params.owner,
				repo: params.repo,
				prNumber,
				branch: params.branchName
			})
			return mergePr(params.owner, params.repo, prNumber, token, logger)
		})

		await step.run("post-merge-result", async () => {
			const t = thread(params.threadId)

			if (mergeOutcome === "merged") {
				logger.info("pr merged", { prNumber, branch: params.branchName })
				const message = [
					"*Merged*",
					"",
					`Squash-merged <${params.prUrl}|PR #${prNumber}> into main.`
				].join("\n")
				await postToThread(t, message, logger, "post merge success to slack")
				return
			}

			if (mergeOutcome === "already_merged") {
				logger.info("pr already merged", { prNumber, branch: params.branchName })
				const message = [
					"*Already Merged*",
					"",
					`<${params.prUrl}|PR #${prNumber}> was already merged.`
				].join("\n")
				await postToThread(t, message, logger, "post already merged to slack")
				return
			}

			logger.info("pr not mergeable, re-cycling", {
				prNumber,
				branch: params.branchName,
				cycle: params.cycle
			})

			if (params.cycle >= MAX_CYCLES) {
				const linkLine = buildSlackLinks(params.prUrl, params.agentUrl)
				const message = [
					"*Merge Failed*",
					"",
					`<${params.prUrl}|PR #${prNumber}> is not mergeable (checks failing or conflicts). Giving up after ${MAX_CYCLES * 10} minutes.`,
					"",
					linkLine
				].join("\n")
				await postToThread(t, message, logger, "post merge failed to slack")
				return
			}

			const sendResult = await errors.try(
				inngest.send({
					name: "cursor/pr.stabilize",
					data: {
						repository: params.repository,
						branchName: params.branchName,
						prUrl: params.prUrl,
						threadId: params.threadId,
						agentUrl: params.agentUrl,
						headSha: afterSha,
						cycle: params.cycle + 1
					}
				})
			)
			if (sendResult.error) {
				logger.error("failed to emit stabilize event for merge retry", { error: sendResult.error })
				throw errors.wrap(sendResult.error, "emit pr.stabilize for merge retry")
			}
		})

		const merged = mergeOutcome !== "not_mergeable"
		return { branch: params.branchName, stable: true, merged, cycle: params.cycle }
	}
)

export { prStabilize }
