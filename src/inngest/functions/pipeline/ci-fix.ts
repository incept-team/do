import * as errors from "@superbuilders/errors"
import * as logger from "@superbuilders/slog"
import { z } from "zod"
import { env } from "@/env"
import { inngest } from "@/inngest"
import { codeFunction } from "@/inngest/functions/agents/code"
import { connectSandbox } from "@/lib/agent/sandbox"
import { transitionPhase } from "@/lib/pipeline/slack-status"

const MAX_CI_FIX_CYCLES = 5
const CI_POLL_INTERVAL = "2m"

const CheckRunSchema = z.object({
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	output: z
		.object({
			title: z.string().nullable(),
			summary: z.string().nullable(),
			text: z.string().nullable()
		})
		.optional()
})

const CheckRunsResponseSchema = z.object({
	total_count: z.number(),
	check_runs: z.array(CheckRunSchema)
})

type CheckRunSummary = {
	name: string
	status: string
	conclusion: string | null
	outputSummary: string | null
}

function parseRepoUrl(githubRepoUrl: string): { owner: string; repo: string } {
	const cleaned = githubRepoUrl.replace(/\.git$/, "").replace(/\/$/, "")
	const match = cleaned.match(/github\.com\/([^/]+)\/([^/]+)$/)
	if (!match || !match[1] || !match[2]) {
		logger.error("invalid github repo url", { githubRepoUrl })
		throw errors.new("invalid github repo url")
	}
	return { owner: match[1], repo: match[2] }
}

function githubHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28"
	}
}

async function fetchCheckRuns(
	owner: string,
	repo: string,
	ref: string,
	token: string
): Promise<CheckRunSummary[]> {
	const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`
	const result = await errors.try(fetch(url, { headers: githubHeaders(token) }))
	if (result.error) {
		logger.error("fetch check runs failed", { error: result.error, owner, repo, ref })
		throw errors.wrap(result.error, "fetch check runs")
	}

	if (!result.data.ok) {
		const text = await result.data.text()
		logger.error("github check-runs api error", { status: result.data.status, body: text })
		throw errors.new(`github check-runs api ${result.data.status}: ${text}`)
	}

	const jsonResult = await errors.try(result.data.json())
	if (jsonResult.error) {
		logger.error("parse check runs json failed", { error: jsonResult.error })
		throw errors.wrap(jsonResult.error, "parse check runs json")
	}

	const parsed = CheckRunsResponseSchema.safeParse(jsonResult.data)
	if (!parsed.success) {
		logger.error("validate check runs response failed", { error: parsed.error })
		throw errors.wrap(parsed.error, "validate check runs response")
	}

	return parsed.data.check_runs.map(function toSummary(cr) {
		const outputParts: string[] = []
		if (cr.output?.title) outputParts.push(cr.output.title)
		if (cr.output?.summary) outputParts.push(cr.output.summary)
		if (cr.output?.text) outputParts.push(cr.output.text)
		const outputSummary = outputParts.length > 0 ? outputParts.join("\n") : null
		return { name: cr.name, status: cr.status, conclusion: cr.conclusion, outputSummary }
	})
}

async function fetchHeadSha(
	owner: string,
	repo: string,
	branch: string,
	token: string
): Promise<string> {
	const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`
	const result = await errors.try(fetch(url, { headers: githubHeaders(token) }))
	if (result.error) {
		logger.error("fetch head sha failed", { error: result.error, owner, repo, branch })
		throw errors.wrap(result.error, "fetch head sha")
	}

	if (!result.data.ok) {
		const text = await result.data.text()
		logger.error("github commit api error", { status: result.data.status, body: text })
		throw errors.new(`github commit api ${result.data.status}: ${text}`)
	}

	const jsonResult = await errors.try(result.data.json())
	if (jsonResult.error) {
		logger.error("parse commit json failed", { error: jsonResult.error })
		throw errors.wrap(jsonResult.error, "parse commit json")
	}

	const parsed = z.object({ sha: z.string().min(1) }).safeParse(jsonResult.data)
	if (!parsed.success) {
		logger.error("validate commit sha failed", { error: parsed.error })
		throw errors.wrap(parsed.error, "validate commit sha")
	}

	return parsed.data.sha
}

function areAllChecksComplete(checks: CheckRunSummary[]): boolean {
	for (const c of checks) {
		if (c.status !== "completed") return false
	}
	return true
}

function getFailedChecks(checks: CheckRunSummary[]): CheckRunSummary[] {
	const result: CheckRunSummary[] = []
	for (const c of checks) {
		if (c.status !== "completed") continue
		if (c.conclusion === "success") continue
		if (c.conclusion === "skipped") continue
		if (c.conclusion === "neutral") continue
		result.push(c)
	}
	return result
}

function formatFailures(failures: CheckRunSummary[]): string {
	const lines: string[] = []
	for (const f of failures) {
		lines.push(`- ${f.name}: ${f.conclusion}`)
	}
	return lines.join("\n")
}

function buildCiFixPrompt(failures: CheckRunSummary[], branch: string, prompt: string): string {
	const sections = [
		"## CI Fix Task",
		"",
		`The following CI checks are failing on branch \`${branch}\`.`,
		"Your job is to fix ALL of them. Make minimal, targeted changes.",
		"Do NOT refactor unrelated code. Fix only what is broken.",
		"",
		"## Original Feature Prompt",
		prompt,
		"",
		"## Failing Checks"
	]

	for (const f of failures) {
		sections.push(`### ${f.name} (${f.conclusion})`)
		if (f.outputSummary) {
			const truncated =
				f.outputSummary.length > 3000
					? `${f.outputSummary.slice(0, 3000)}\n... (truncated)`
					: f.outputSummary
			sections.push(truncated)
		}
		sections.push("")
	}

	sections.push(
		"## Instructions",
		"1. Read the failing check output carefully.",
		"2. Identify the root cause of each failure.",
		"3. Make the minimum code changes to fix all failures.",
		"4. Do NOT add new features or refactor existing code.",
		"5. After making changes, verify by reading the files you changed."
	)

	return sections.join("\n")
}

async function runSandboxGit(
	sandboxId: string,
	args: string[]
): Promise<{ stdout: string; exitCode: number }> {
	const sandbox = await connectSandbox(sandboxId, logger)
	const cmdResult = await errors.try(sandbox.runCommand("git", args))
	if (cmdResult.error) {
		logger.error("git command failed", { error: cmdResult.error, args })
		throw errors.wrap(cmdResult.error, `git ${args[0]}`)
	}
	const cmd = cmdResult.data
	const stdoutResult = await errors.try(cmd.stdout())
	if (stdoutResult.error) {
		logger.error("git stdout failed", { error: stdoutResult.error })
		throw errors.wrap(stdoutResult.error, `git ${args[0]} stdout`)
	}
	return { stdout: stdoutResult.data, exitCode: cmd.exitCode }
}

const ciFixFunction = inngest.createFunction(
	{ id: "paul/pipeline/ci-fix" },
	{ event: "paul/pipeline/ci-fix" },
	async ({ event, step }) => {
		const {
			runId,
			sandboxId,
			prompt,
			githubRepoUrl,
			githubBranch,
			branch,
			prNumber,
			prUrl,
			slackThreadId,
			slackMessageId,
			cycle
		} = event.data

		logger.info("starting ci-fix cycle", { runId, branch, prNumber, cycle })

		const token = env.GITHUB_PAT_TOKEN
		if (!token) {
			logger.error("missing GITHUB_PAT_TOKEN")
			throw errors.new("GITHUB_PAT_TOKEN not configured")
		}

		const { owner, repo } = parseRepoUrl(githubRepoUrl)

		const headSha = await step.run("get-head-sha", async function getHead() {
			return fetchHeadSha(owner, repo, branch, token)
		})

		await step.sleep("wait-for-ci-start", CI_POLL_INTERVAL)

		let checks = await step.run("poll-checks-1", async function pollFirst() {
			return fetchCheckRuns(owner, repo, headSha, token)
		})

		if (!areAllChecksComplete(checks)) {
			await step.sleep("wait-for-ci-finish", CI_POLL_INTERVAL)

			checks = await step.run("poll-checks-2", async function pollSecond() {
				return fetchCheckRuns(owner, repo, headSha, token)
			})
		}

		if (!areAllChecksComplete(checks)) {
			await step.sleep("wait-for-ci-finish-3", "5m")

			checks = await step.run("poll-checks-3", async function pollThird() {
				return fetchCheckRuns(owner, repo, headSha, token)
			})
		}

		const failedChecks = getFailedChecks(checks)
		const allPassed = areAllChecksComplete(checks) && failedChecks.length === 0

		if (allPassed) {
			logger.info("all ci checks passed", { runId, branch, prNumber, cycle })

			if (slackThreadId && slackMessageId) {
				await step.run("slack-ci-pass", async function slackCiPass() {
					await transitionPhase({
						threadId: slackThreadId,
						messageId: slackMessageId,
						previousPhase: cycle === 1 ? "pr_created" : "ci_fixing",
						newPhase: "complete",
						detail: `All CI checks pass on <${prUrl}|PR #${prNumber}>. Ready for review and merge.`
					})
				})
			}

			return { status: "ci_passed" as const, branch, prNumber, cycle }
		}

		logger.warn("ci checks failed", {
			runId,
			branch,
			prNumber,
			cycle,
			failedCount: failedChecks.length,
			failures: failedChecks.map(function name(f) {
				return f.name
			})
		})

		if (cycle >= MAX_CI_FIX_CYCLES) {
			logger.error("max ci-fix cycles reached", { runId, cycle })

			if (slackThreadId && slackMessageId) {
				await step.run("slack-ci-max-reached", async function slackCiMax() {
					await transitionPhase({
						threadId: slackThreadId,
						messageId: slackMessageId,
						previousPhase: "ci_fixing",
						newPhase: "failed",
						detail: `CI checks still failing after ${MAX_CI_FIX_CYCLES} fix attempts on <${prUrl}|PR #${prNumber}>. Needs human attention.\n\nFailing checks:\n${formatFailures(failedChecks)}`
					})
				})
			}

			return { status: "ci_fix_exhausted" as const, branch, prNumber, cycle, failedChecks }
		}

		if (slackThreadId && slackMessageId) {
			await step.run(`slack-ci-fix-${cycle}`, async function slackCiFix() {
				await transitionPhase({
					threadId: slackThreadId,
					messageId: slackMessageId,
					previousPhase: cycle === 1 ? "pr_created" : "ci_fixing",
					newPhase: "ci_fixing",
					detail: `CI fix attempt ${cycle}/${MAX_CI_FIX_CYCLES}. Fixing:\n${formatFailures(failedChecks)}`
				})
			})
		}

		await step.run("checkout-branch", async function checkoutBranch() {
			await runSandboxGit(sandboxId, ["fetch", "origin", branch])
			await runSandboxGit(sandboxId, ["checkout", branch])
			await runSandboxGit(sandboxId, ["pull", "origin", branch])
		})

		const fixPrompt = buildCiFixPrompt(failedChecks, branch, prompt)

		const coderResult = await step.invoke(`coder-fix-${cycle}`, {
			function: codeFunction,
			data: {
				prompt: fixPrompt,
				sandboxId,
				github: { repoUrl: githubRepoUrl, branch }
			}
		})

		logger.info("ci fix coder complete", {
			cycle,
			stepCount: coderResult.stepCount,
			textLength: coderResult.text.length
		})

		await step.run("commit-and-push", async function commitAndPush() {
			await runSandboxGit(sandboxId, ["add", "-A"])

			const diffResult = await runSandboxGit(sandboxId, ["diff", "--cached", "--stat"])
			if (!diffResult.stdout.trim()) {
				logger.info("no changes to commit from ci fix", { cycle })
				return
			}

			await runSandboxGit(sandboxId, [
				"commit",
				"-m",
				`fix: ci failures (auto-fix attempt ${cycle})`
			])
			await runSandboxGit(sandboxId, ["push", "origin", branch])
			logger.info("ci fix pushed", { cycle, branch })
		})

		await step.sendEvent("emit-next-ci-fix", {
			name: "paul/pipeline/ci-fix" as const,
			data: {
				runId,
				sandboxId,
				prompt,
				githubRepoUrl,
				githubBranch,
				branch,
				prNumber,
				prUrl,
				slackThreadId,
				slackMessageId,
				cycle: cycle + 1
			}
		})

		return { status: "ci_fix_retrying" as const, branch, prNumber, cycle }
	}
)

export { ciFixFunction }
