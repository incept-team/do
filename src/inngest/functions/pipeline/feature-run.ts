import * as errors from "@superbuilders/errors"
import * as logger from "@superbuilders/slog"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/db"
import { featureRuns } from "@/db/schemas/agent"
import { inngest } from "@/inngest"
import type { AnalysisOutput } from "@/inngest/functions/pipeline/analysis"
import { analysisFunction } from "@/inngest/functions/pipeline/analysis"
import type { ApproachesOutput } from "@/inngest/functions/pipeline/approaches"
import { ApproachesOutputSchema, approachesFunction } from "@/inngest/functions/pipeline/approaches"
import type { ImplementationOutput } from "@/inngest/functions/pipeline/implementation"
import {
	ImplementationOutputSchema,
	implementationFunction
} from "@/inngest/functions/pipeline/implementation"
import { judgingFunction } from "@/inngest/functions/pipeline/judging"
import { createFunction as sandboxCreateFunction } from "@/inngest/functions/sandbox/create"
import { stopFunction as sandboxStopFunction } from "@/inngest/functions/sandbox/stop"
import { CtaResponseEventSchema } from "@/lib/agent/cta"
import {
	completeFeatureRun,
	createFeatureRun,
	createPhaseResult,
	createSandboxRecord,
	failFeatureRun,
	failPhaseResult,
	passPhaseResult,
	updateFeatureRunPhase
} from "@/lib/pipeline/persistence"
import { createPR } from "@/lib/pipeline/pr-creation"
import { loadRepoMemories, upsertRepoMemory } from "@/lib/pipeline/repo-memory"
import type { PhaseStatus } from "@/lib/pipeline/slack-status"
import { transitionPhase } from "@/lib/pipeline/slack-status"

const CTA_TIMEOUT = "30d" as const

type PipelineMode = "autonomous" | "supervised"

type InngestStep = Parameters<Parameters<typeof inngest.createFunction>[2]>[0]["step"]
type InngestLogger = Parameters<Parameters<typeof inngest.createFunction>[2]>[0]["logger"]

type SlackContext = {
	threadId: string | undefined
	messageId: string | undefined
}

type Memory = { phase: string; kind: string; content: string }

const MemoryArraySchema = z.array(
	z.object({
		phase: z.string(),
		kind: z.string(),
		content: z.string()
	})
)

async function emitSlackPhase(
	ctx: SlackContext,
	previousPhase: PhaseStatus | undefined,
	newPhase: PhaseStatus,
	detail: string,
	step: InngestStep
): Promise<void> {
	if (!ctx.threadId || !ctx.messageId) return
	const threadId = ctx.threadId
	const messageId = ctx.messageId
	await step.run(`slack-phase-${newPhase}`, async function slackPhaseStep() {
		await transitionPhase({ threadId, messageId, previousPhase, newPhase, detail })
	})
}

async function readMemoriesFromDb(
	runId: string,
	stepName: string,
	step: InngestStep,
	logger: InngestLogger
): Promise<Memory[]> {
	logger.debug("reading memories", { runId, stepName })
	return step.run(stepName, async function readMemoriesStep() {
		const result = await errors.try(
			db
				.select({ memories: featureRuns.memories })
				.from(featureRuns)
				.where(eq(featureRuns.id, runId))
				.limit(1)
		)
		if (result.error) {
			logger.error("reading memories failed", { error: result.error, runId })
			throw errors.wrap(result.error, "read feature run memories")
		}

		const row = result.data[0]
		if (!row) {
			return []
		}

		const parsed = MemoryArraySchema.safeParse(row.memories)
		if (!parsed.success) {
			return []
		}

		return parsed.data
	})
}

async function emitCtaAndWait(
	ctaId: string,
	ctaData: Record<string, unknown>,
	stepPrefix: string,
	step: InngestStep,
	logger: InngestLogger
): Promise<z.infer<typeof CtaResponseEventSchema> | null> {
	await step.sendEvent(`cta-emit-${stepPrefix}`, {
		name: "paul/cta/request" as const,
		data: ctaData
	})

	logger.info("cta emitted, suspending", { ctaId, stepPrefix })

	const ctaResponse = await step.waitForEvent(`cta-wait-${stepPrefix}`, {
		event: "paul/cta/response",
		if: `async.data.ctaId == "${ctaId}"`,
		timeout: CTA_TIMEOUT
	})

	if (!ctaResponse) {
		logger.warn("cta timeout", { ctaId, stepPrefix })
		return null
	}

	logger.info("cta response received", { ctaId, kind: ctaResponse.data.kind })

	const validated = CtaResponseEventSchema.safeParse(ctaResponse.data)
	if (!validated.success) {
		logger.error("cta response validation failed", { error: validated.error })
		throw errors.new("cta response validation failed")
	}

	return validated.data
}

async function handleCtaTimeout(
	runId: string,
	sandboxId: string,
	phaseResultId: string,
	step: InngestStep,
	logger: InngestLogger
): Promise<{ status: "failed"; reason: string }> {
	logger.warn("cta timed out, failing run", { runId })

	await step.run("fail-phase-timeout", async function failPhaseTimeout() {
		await failPhaseResult(db, phaseResultId)
	})

	await step.run("fail-run-timeout", async function failRunTimeout() {
		await failFeatureRun(db, runId)
	})

	await step.invoke("stop-sandbox-timeout", {
		function: sandboxStopFunction,
		data: { sandboxId }
	})

	return { status: "failed" as const, reason: "cta_timeout" }
}

async function handlePhaseFailure(
	runId: string,
	sandboxId: string,
	phaseResultId: string,
	failedPhase: string,
	step: InngestStep,
	logger: InngestLogger
): Promise<{ status: "failed"; failedPhase: string }> {
	logger.error("phase failed, failing run", { runId, failedPhase })

	await step.run("fail-phase-result", async function failPhaseStep() {
		await failPhaseResult(db, phaseResultId)
	})

	await step.run("fail-run", async function failRunStep() {
		await failFeatureRun(db, runId)
	})

	await step.invoke("stop-sandbox-failure", {
		function: sandboxStopFunction,
		data: { sandboxId }
	})

	return { status: "failed" as const, failedPhase }
}

function validateApproachesOutput(raw: unknown, logger: InngestLogger): ApproachesOutput {
	const result = ApproachesOutputSchema.safeParse(raw)
	if (!result.success) {
		logger.error("approaches invoke result validation failed", { error: result.error })
		throw errors.wrap(result.error, "approaches invoke result validation")
	}
	return result.data
}

function validateImplementationOutput(raw: unknown, logger: InngestLogger): ImplementationOutput {
	const result = ImplementationOutputSchema.safeParse(raw)
	if (!result.success) {
		logger.error("implementation invoke result validation failed", { error: result.error })
		throw errors.wrap(result.error, "implementation invoke result validation")
	}
	return result.data
}

async function selectApproach(ctx: {
	approachesOutput: ApproachesOutput
	approachesPhaseResultId: string
	runId: string
	sandboxId: string
	step: InngestStep
	logger: InngestLogger
}): Promise<
	{ ok: true; selected: unknown } | { ok: false; failure: { status: "failed"; reason: string } }
> {
	const { approachesOutput, approachesPhaseResultId, runId, sandboxId, step, logger } = ctx
	const ctaId = await step.run("gen-cta-id-approaches", function genCtaId() {
		return crypto.randomUUID()
	})
	const approachCount = approachesOutput.approaches.length

	if (approachCount < 2) {
		const approvalResponse = await emitCtaAndWait(
			ctaId,
			{
				ctaId,
				runId,
				kind: "approval" as const,
				message: "Proceed with the single approach?"
			},
			"after-approaches",
			step,
			logger
		)

		if (!approvalResponse) {
			const failure = await handleCtaTimeout(
				runId,
				sandboxId,
				approachesPhaseResultId,
				step,
				logger
			)
			return { ok: false, failure }
		}

		return { ok: true, selected: approachesOutput.approaches[0] }
	}

	const choiceOptions = approachesOutput.approaches.map(function buildOption(a) {
		return { id: a.id, label: a.title }
	})

	const choiceResponse = await emitCtaAndWait(
		ctaId,
		{
			ctaId,
			runId,
			kind: "choice" as const,
			prompt: "Which approach should I pursue?",
			options: choiceOptions
		},
		"after-approaches",
		step,
		logger
	)

	if (!choiceResponse) {
		const failure = await handleCtaTimeout(runId, sandboxId, approachesPhaseResultId, step, logger)
		return { ok: false, failure }
	}

	if (choiceResponse.kind !== "choice") {
		logger.error("unexpected cta response kind for approach selection", {
			expected: "choice",
			actual: choiceResponse.kind
		})
		throw errors.new("unexpected cta response kind for approach selection")
	}

	const selectedId = choiceResponse.selectedId
	const found = approachesOutput.approaches.find(function matchApproach(a) {
		return a.id === selectedId
	})

	if (!found) {
		logger.error("selected approach not found", {
			selectedId,
			availableIds: approachesOutput.approaches.map(function getId(a) {
				return a.id
			})
		})
		throw errors.new("selected approach not found in approaches output")
	}

	return { ok: true, selected: found }
}

function pickBestApproach(
	approachesOutput: ApproachesOutput
): ApproachesOutput["approaches"][number] {
	const recommended = approachesOutput.recommendation
	const approaches = approachesOutput.approaches
	const lowerRecommended = recommended.toLowerCase()
	const match = approaches.find(function matchRecommendation(a) {
		if (lowerRecommended.includes(a.id.toLowerCase())) return true
		return lowerRecommended.includes(a.title.toLowerCase())
	})
	const first = approaches[0]
	if (!first) {
		logger.error("no approaches available to select")
		throw errors.new("no approaches available to select")
	}
	const chosen = match ? match : first
	logger.info("auto-selected approach", {
		approachId: chosen.id,
		title: chosen.title,
		total: approaches.length
	})
	return chosen
}

async function requireApproval(ctx: {
	isAutonomous: boolean
	runId: string
	sandboxId: string
	phaseResultId: string
	message: string
	stepPrefix: string
	slack: SlackContext
	slackPreviousPhase: PhaseStatus
	step: InngestStep
	logger: InngestLogger
}): Promise<{ proceed: true } | { proceed: false; failure: { status: "failed"; reason: string } }> {
	if (ctx.isAutonomous) {
		return { proceed: true }
	}

	const ctaId = await ctx.step.run(`gen-cta-id-${ctx.stepPrefix}`, function genCtaId() {
		return crypto.randomUUID()
	})
	const ctaResponse = await emitCtaAndWait(
		ctaId,
		{ ctaId, runId: ctx.runId, kind: "approval" as const, message: ctx.message },
		ctx.stepPrefix,
		ctx.step,
		ctx.logger
	)
	if (ctaResponse) {
		return { proceed: true }
	}

	await emitSlackPhase(
		ctx.slack,
		ctx.slackPreviousPhase,
		"failed",
		`CTA timed out (${ctx.stepPrefix}).`,
		ctx.step
	)
	const failure = await handleCtaTimeout(
		ctx.runId,
		ctx.sandboxId,
		ctx.phaseResultId,
		ctx.step,
		ctx.logger
	)
	return { proceed: false, failure }
}

const featureRunFunction = inngest.createFunction(
	{ id: "paul/pipeline/feature-run" },
	{ event: "paul/pipeline/feature-run" },
	async ({ event, logger, step }) => {
		const { prompt, githubRepoUrl, githubBranch, runtime } = event.data
		const mode: PipelineMode = event.data.mode ? event.data.mode : "supervised"
		const slack: SlackContext = {
			threadId: event.data.slackThreadId,
			messageId: event.data.slackMessageId
		}
		const isAutonomous = mode === "autonomous"

		logger.info("starting feature run", { githubRepoUrl, githubBranch, runtime, mode })

		const sandboxResult = await step.invoke("create-sandbox", {
			function: sandboxCreateFunction,
			data: {
				runtime,
				github: {
					repoUrl: githubRepoUrl,
					branch: githubBranch
				}
			}
		})

		const sandboxId = sandboxResult.sandboxId

		logger.info("sandbox created", { sandboxId })

		await step.run("persist-sandbox-record", async function persistSandbox() {
			await createSandboxRecord(db, {
				id: sandboxId,
				status: "running",
				runtime,
				memory: 512,
				vcpus: 2,
				region: "us-east-1",
				cwd: "/home/user",
				timeout: 300
			})
		})

		const runId = await step.run("create-feature-run", async function createRun() {
			const id = crypto.randomUUID()
			await createFeatureRun(db, {
				id,
				prompt,
				sandboxId,
				githubRepoUrl,
				githubBranch,
				currentPhase: "analysis"
			})
			return id
		})

		await emitSlackPhase(slack, undefined, "analysis", "Exploring the codebase...", step)

		const analysisPhaseResultId = await step.run(
			"create-phase-analysis",
			async function createAnalysisPhase() {
				const id = crypto.randomUUID()
				await createPhaseResult(db, { id, runId, phase: "analysis" })
				return id
			}
		)

		const analysisMemories = await readMemoriesFromDb(runId, "read-memories-analysis", step, logger)

		const repoMems = await step.run("load-repo-memories", async function loadRepoMems() {
			return loadRepoMemories(db, githubRepoUrl)
		})

		const repoMemoriesAsRunMemories: Memory[] = repoMems.map(function toRunMemory(m) {
			return { phase: m.phase ? m.phase : "repo", kind: m.key, content: m.content }
		})
		const enrichedMemories = [...repoMemoriesAsRunMemories, ...analysisMemories]

		const analysisInvokeResult = await errors.try(
			step.invoke("invoke-analysis", {
				function: analysisFunction,
				data: {
					runId,
					sandboxId,
					prompt,
					githubRepoUrl,
					githubBranch,
					memories: enrichedMemories
				}
			})
		)
		if (analysisInvokeResult.error) {
			logger.error("analysis phase failed", { error: analysisInvokeResult.error })
			return handlePhaseFailure(runId, sandboxId, analysisPhaseResultId, "analysis", step, logger)
		}

		const analysisOutput: AnalysisOutput = analysisInvokeResult.data

		await step.run("pass-phase-analysis", async function passAnalysis() {
			await passPhaseResult(db, analysisPhaseResultId, analysisOutput)
		})

		await step.run("persist-repo-memories-analysis", async function persistRepoMems() {
			await upsertRepoMemory(
				db,
				githubRepoUrl,
				"architecture",
				analysisOutput.feasibilityAssessment,
				{ phase: "analysis", runId }
			)
			if (analysisOutput.architecturalConstraints.length > 0) {
				await upsertRepoMemory(
					db,
					githubRepoUrl,
					"constraints",
					analysisOutput.architecturalConstraints.join("; "),
					{ phase: "analysis", runId }
				)
			}
			if (analysisOutput.risks.length > 0) {
				await upsertRepoMemory(db, githubRepoUrl, "known-risks", analysisOutput.risks.join("; "), {
					phase: "analysis",
					runId
				})
			}
		})

		await step.run("advance-phase-analysis", async function advanceAnalysis() {
			await updateFeatureRunPhase(db, runId, "approaches")
		})

		const analysisGate = await requireApproval({
			isAutonomous,
			runId,
			sandboxId,
			phaseResultId: analysisPhaseResultId,
			message: "Analysis complete. Approve to proceed to approach generation?",
			stepPrefix: "after-analysis",
			slack,
			slackPreviousPhase: "analysis",
			step,
			logger
		})
		if (!analysisGate.proceed) return analysisGate.failure

		await emitSlackPhase(slack, "analysis", "approaches", "Generating design proposals...", step)

		const approachesPhaseResultId = await step.run(
			"create-phase-approaches",
			async function createApproachesPhase() {
				const id = crypto.randomUUID()
				await createPhaseResult(db, { id, runId, phase: "approaches" })
				return id
			}
		)

		const approachesMemories = await readMemoriesFromDb(
			runId,
			"read-memories-approaches",
			step,
			logger
		)

		const approachesInvokeResult = await errors.try(
			step.invoke("invoke-approaches", {
				function: approachesFunction,
				data: {
					runId,
					sandboxId,
					prompt,
					githubRepoUrl,
					githubBranch,
					memories: approachesMemories,
					analysisOutput
				}
			})
		)
		if (approachesInvokeResult.error) {
			logger.error("approaches phase failed", { error: approachesInvokeResult.error })
			return handlePhaseFailure(
				runId,
				sandboxId,
				approachesPhaseResultId,
				"approaches",
				step,
				logger
			)
		}

		const approachesOutput = validateApproachesOutput(approachesInvokeResult.data, logger)

		await step.run("pass-phase-approaches", async function passApproaches() {
			await passPhaseResult(db, approachesPhaseResultId, approachesOutput)
		})

		await step.run("advance-phase-approaches", async function advanceApproaches() {
			await updateFeatureRunPhase(db, runId, "judging")
		})

		let selectedApproach: unknown

		if (isAutonomous) {
			selectedApproach = await step.run("auto-select-approach", function autoSelectStep() {
				return pickBestApproach(approachesOutput)
			})
		} else {
			const approachResult = await selectApproach({
				approachesOutput,
				approachesPhaseResultId,
				runId,
				sandboxId,
				step,
				logger
			})

			if (!approachResult.ok) {
				await emitSlackPhase(slack, "approaches", "failed", "Approach selection timed out.", step)
				return approachResult.failure
			}

			selectedApproach = approachResult.selected
		}

		logger.info("approach selected", { runId })

		await emitSlackPhase(slack, "approaches", "judging", "Evaluating selected approach...", step)

		const judgingPhaseResultId = await step.run(
			"create-phase-judging",
			async function createJudgingPhase() {
				const id = crypto.randomUUID()
				await createPhaseResult(db, { id, runId, phase: "judging" })
				return id
			}
		)

		const judgingMemories = await readMemoriesFromDb(runId, "read-memories-judging", step, logger)

		const judgingInvokeResult = await errors.try(
			step.invoke("invoke-judging", {
				function: judgingFunction,
				data: {
					runId,
					sandboxId,
					prompt,
					githubRepoUrl,
					githubBranch,
					memories: judgingMemories,
					selectedApproach,
					analysisOutput
				}
			})
		)
		if (judgingInvokeResult.error) {
			logger.error("judging phase failed", { error: judgingInvokeResult.error })
			return handlePhaseFailure(runId, sandboxId, judgingPhaseResultId, "judging", step, logger)
		}

		const judgingOutput = judgingInvokeResult.data

		await step.run("pass-phase-judging", async function passJudging() {
			await passPhaseResult(db, judgingPhaseResultId, judgingOutput)
		})

		await step.run("advance-phase-judging", async function advanceJudging() {
			await updateFeatureRunPhase(db, runId, "implementation")
		})

		const judgingGate = await requireApproval({
			isAutonomous,
			runId,
			sandboxId,
			phaseResultId: judgingPhaseResultId,
			message: "Approach passed review. Begin implementation?",
			stepPrefix: "after-judging",
			slack,
			slackPreviousPhase: "judging",
			step,
			logger
		})
		if (!judgingGate.proceed) return judgingGate.failure

		await emitSlackPhase(slack, "judging", "implementation", "Implementing changes...", step)

		const implPhaseResultId = await step.run(
			"create-phase-implementation",
			async function createImplPhase() {
				const id = crypto.randomUUID()
				await createPhaseResult(db, { id, runId, phase: "implementation" })
				return id
			}
		)

		const implMemories = await readMemoriesFromDb(
			runId,
			"read-memories-implementation",
			step,
			logger
		)

		const implInvokeResult = await errors.try(
			step.invoke("invoke-implementation", {
				function: implementationFunction,
				data: {
					runId,
					sandboxId,
					prompt,
					githubRepoUrl,
					githubBranch,
					memories: implMemories,
					selectedApproach,
					analysisOutput,
					judgingOutput
				}
			})
		)
		if (implInvokeResult.error) {
			logger.error("implementation phase failed", { error: implInvokeResult.error })
			return handlePhaseFailure(runId, sandboxId, implPhaseResultId, "implementation", step, logger)
		}

		const implOutput = validateImplementationOutput(implInvokeResult.data, logger)

		await step.run("pass-phase-implementation", async function passImpl() {
			await passPhaseResult(db, implPhaseResultId, implOutput)
		})

		await step.run("advance-phase-implementation", async function advanceImpl() {
			await updateFeatureRunPhase(db, runId, "pr")
		})

		const implGate = await requireApproval({
			isAutonomous,
			runId,
			sandboxId,
			phaseResultId: implPhaseResultId,
			message: "Implementation complete, all gates pass. Create PR?",
			stepPrefix: "after-implementation",
			slack,
			slackPreviousPhase: "implementation",
			step,
			logger
		})
		if (!implGate.proceed) return implGate.failure

		const prPhaseResultId = await step.run("create-phase-pr", async function createPrPhase() {
			const id = crypto.randomUUID()
			await createPhaseResult(db, { id, runId, phase: "pr" })
			return id
		})

		const prResult = await step.run("create-pr", async function createPrStep() {
			return createPR({
				branch: implOutput.branch,
				githubRepoUrl,
				prompt,
				analysisOutput,
				approachOutput: selectedApproach,
				implOutput
			})
		})

		await step.run("pass-phase-pr", async function passPr() {
			await passPhaseResult(db, prPhaseResultId, prResult)
		})

		await emitSlackPhase(
			slack,
			"implementation",
			"pr_created",
			`PR created: <${prResult.prUrl}|#${prResult.prNumber} — ${prResult.title}>`,
			step
		)

		if (isAutonomous) {
			await step.sendEvent("trigger-ci-fix", {
				name: "paul/pipeline/ci-fix" as const,
				data: {
					runId,
					sandboxId,
					prompt,
					githubRepoUrl,
					githubBranch,
					branch: implOutput.branch,
					prNumber: prResult.prNumber,
					prUrl: prResult.prUrl,
					slackThreadId: slack.threadId,
					slackMessageId: slack.messageId,
					cycle: 1
				}
			})
		}

		await step.run("complete-run", async function completeRun() {
			await completeFeatureRun(db, runId)
		})

		await step.invoke("stop-sandbox-done", {
			function: sandboxStopFunction,
			data: { sandboxId }
		})

		if (!isAutonomous) {
			await emitSlackPhase(
				slack,
				"pr_created",
				"complete",
				"Pipeline complete. PR is ready for review.",
				step
			)
		}

		logger.info("feature run complete", { runId, prUrl: prResult.prUrl, mode })

		return { status: "completed" as const, prUrl: prResult.prUrl, mode }
	}
)

export { featureRunFunction }
