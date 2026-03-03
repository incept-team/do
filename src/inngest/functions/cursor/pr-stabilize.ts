import * as errors from "@superbuilders/errors"
import * as logger from "@superbuilders/slog"
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

function parseRepository(repository: string): { owner: string; repo: string } {
	const parts = repository.split("/")
	const owner = parts[0]
	const repo = parts[1]

	if (!owner || !repo) {
		logger.error("invalid repository format", { repository })
		throw errors.new("invalid repository format")
	}

	return { owner, repo }
}

const prStabilize = inngest.createFunction(
	{ id: "cursor/pr-stabilize" },
	[
		{
			event: "cursor/agent.finished",
			if: "event.data.status == 'FINISHED' && event.data.branchName != null"
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
				return {
					repository: d.repository,
					branchName: d.branchName,
					prUrl: d.prUrl,
					threadId: d.threadId,
					agentUrl: d.agentUrl,
					cycle: d.cycle
				}
			}

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

			return {
				repository: d.repository,
				branchName: d.branchName,
				prUrl: d.prUrl,
				threadId: row.threadId,
				agentUrl,
				cycle: 1
			}
		})

		const { owner, repo } = parseRepository(params.repository)

		const beforeSha = await step.run("get-head-commit", async () => {
			logger.info("fetching head sha before sleep", {
				owner,
				repo,
				branch: params.branchName,
				cycle: params.cycle
			})
			return getHeadSha(owner, repo, params.branchName, token, logger)
		})

		await step.sleep("wait-for-bugbot", SLEEP_DURATION)

		const afterSha = await step.run("check-for-new-commits", async () => {
			logger.info("fetching head sha after sleep", {
				owner,
				repo,
				branch: params.branchName,
				cycle: params.cycle
			})
			return getHeadSha(owner, repo, params.branchName, token, logger)
		})

		await step.run("handle-result", async () => {
			const t = thread(params.threadId)

			if (beforeSha === afterSha) {
				logger.info("pr stable", {
					branch: params.branchName,
					sha: afterSha,
					cycle: params.cycle
				})

				const links: string[] = []
				if (params.prUrl) {
					links.push(`<${params.prUrl}|View PR>`)
				}
				links.push(`<${params.agentUrl}|View in Cursor>`)
				const linkLine = links.join(" \u00b7 ")

				const message = [
					"*PR Stable*",
					"",
					`No new commits on \`${params.branchName}\` in the last 10 minutes.`,
					"",
					linkLine
				].join("\n")

				const postResult = await errors.try(t.post(message))
				if (postResult.error) {
					logger.error("failed to post stable message", { error: postResult.error })
					throw errors.wrap(postResult.error, "post stable message to slack")
				}

				return
			}

			if (params.cycle >= MAX_CYCLES) {
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
					`<${params.agentUrl}|View in Cursor>`
				].join("\n")

				const postResult = await errors.try(t.post(message))
				if (postResult.error) {
					logger.error("failed to post max-cycles message", { error: postResult.error })
					throw errors.wrap(postResult.error, "post max-cycles message to slack")
				}

				return
			}

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

		return { branch: params.branchName, stable: beforeSha === afterSha, cycle: params.cycle }
	}
)

export { prStabilize }
