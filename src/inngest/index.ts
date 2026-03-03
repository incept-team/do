import { realtimeMiddleware } from "@inngest/realtime/middleware"
import * as logger from "@superbuilders/slog"
import { EventSchemas, Inngest, type Logger } from "inngest"
import { z } from "zod"
import { env } from "@/env"
import { CtaRequestEventSchema, CtaResponseEventSchema } from "@/lib/agent/cta"
import { CursorImageArraySchema } from "@/lib/slack-images"

const schema = {
	"superstarter/hello": z.object({
		message: z.string().min(1)
	}),
	"paul/agents/explore": z.object({
		prompt: z.string().min(1),
		sandboxId: z.string().min(1),
		github: z
			.object({
				repoUrl: z.string().url(),
				branch: z.string().min(1)
			})
			.optional()
	}),
	"paul/agents/code": z.object({
		prompt: z.string().min(1),
		sandboxId: z.string().min(1),
		github: z
			.object({
				repoUrl: z.string().url(),
				branch: z.string().min(1)
			})
			.optional()
	}),
	"paul/sandbox/create": z.object({
		runtime: z.enum(["node24", "node22", "python3.13"]).default("node24"),
		github: z
			.object({
				repoUrl: z.string().url(),
				branch: z.string().min(1),
				token: z.string().min(1).optional()
			})
			.optional()
	}),
	"paul/sandbox/stop": z.object({
		sandboxId: z.string().min(1)
	}),
	"paul/agents/orchestrate": z.object({
		prompt: z.string().min(1),
		sandboxId: z.string().min(1),
		github: z
			.object({
				repoUrl: z.string().url(),
				branch: z.string().min(1)
			})
			.optional()
	}),
	"paul/cta/request": CtaRequestEventSchema,
	"paul/cta/response": CtaResponseEventSchema,
	"paul/debug/echo": z.object({
		source: z.string().min(1),
		payload: z.record(z.string(), z.unknown())
	}),
	"paul/pipeline/feature-run": z.object({
		prompt: z.string().min(1),
		githubRepoUrl: z.string().url(),
		githubBranch: z.string().min(1),
		runtime: z.enum(["node24", "node22", "python3.13"]).default("node24")
	}),
	"paul/pipeline/analysis": z.object({
		runId: z.string().uuid(),
		sandboxId: z.string().min(1),
		prompt: z.string().min(1),
		githubRepoUrl: z.string().url(),
		githubBranch: z.string().min(1),
		memories: z.array(
			z.object({
				phase: z.string().min(1),
				kind: z.string().min(1),
				content: z.string().min(1)
			})
		)
	}),
	"paul/pipeline/approaches": z.object({
		runId: z.string().uuid(),
		sandboxId: z.string().min(1),
		prompt: z.string().min(1),
		githubRepoUrl: z.string().url(),
		githubBranch: z.string().min(1),
		memories: z.array(
			z.object({
				phase: z.string().min(1),
				kind: z.string().min(1),
				content: z.string().min(1)
			})
		),
		analysisOutput: z.unknown()
	}),
	"paul/pipeline/judging": z.object({
		runId: z.string().uuid(),
		sandboxId: z.string().min(1),
		prompt: z.string().min(1),
		githubRepoUrl: z.string().url(),
		githubBranch: z.string().min(1),
		memories: z.array(
			z.object({
				phase: z.string().min(1),
				kind: z.string().min(1),
				content: z.string().min(1)
			})
		),
		selectedApproach: z.unknown(),
		analysisOutput: z.unknown()
	}),
	"paul/pipeline/implementation": z.object({
		runId: z.string().uuid(),
		sandboxId: z.string().min(1),
		prompt: z.string().min(1),
		githubRepoUrl: z.string().url(),
		githubBranch: z.string().min(1),
		memories: z.array(
			z.object({
				phase: z.string().min(1),
				kind: z.string().min(1),
				content: z.string().min(1)
			})
		),
		selectedApproach: z.unknown(),
		analysisOutput: z.unknown(),
		judgingOutput: z.unknown()
	}),
	"cursor/agent.launch": z.object({
		prompt: z.string().min(1),
		repository: z.string().min(1),
		ref: z.string().min(1),
		threadId: z.string().min(1),
		images: CursorImageArraySchema,
		model: z.string().min(1).optional(),
		branchName: z.string().min(1).optional(),
		autoCreatePr: z.boolean().optional(),
		openAsCursorGithubApp: z.boolean().optional(),
		skipReviewerRequest: z.boolean().optional()
	}),
	"cursor/followup.sent": z.object({
		agentId: z.string().min(1),
		threadId: z.string().min(1),
		agentUrl: z.string().min(1)
	}),
	"cursor/agent.finished": z.object({
		agentId: z.string().min(1),
		status: z.enum(["FINISHED", "ERROR"]),
		summary: z.string().optional(),
		repository: z.string().optional(),
		branchName: z.string().optional(),
		prUrl: z.string().optional(),
		agentUrl: z.string().optional()
	}),
	"cursor/pr.stabilize": z.object({
		repository: z.string().min(1),
		branchName: z.string().min(1),
		prUrl: z.string().optional(),
		threadId: z.string().min(1),
		agentUrl: z.string().min(1),
		headSha: z.string().min(1),
		cycle: z.number().int().min(1).max(5)
	})
}

const inngestLogger: Logger = {
	info: logger.info,
	warn: logger.warn,
	error: logger.error,
	debug: logger.debug
}

const inngest = new Inngest({
	id: "paul",
	checkpointing: true,
	schemas: new EventSchemas().fromSchema(schema),
	logger: inngestLogger,
	eventKey: env.INNGEST_EVENT_KEY,
	signingKey: env.INNGEST_SIGNING_KEY,
	middleware: [realtimeMiddleware()]
})

export { inngest }
