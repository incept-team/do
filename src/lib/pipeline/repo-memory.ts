import * as errors from "@superbuilders/errors"
import * as logger from "@superbuilders/slog"
import { and, eq } from "drizzle-orm"
import type { db as dbClient } from "@/db"
import { repoMemories } from "@/db/schemas/agent"

type Db = typeof dbClient

type RepoMemory = {
	key: string
	content: string
	phase: string | null
}

async function loadRepoMemories(db: Db, repoUrl: string): Promise<RepoMemory[]> {
	const result = await errors.try(
		db
			.select({
				key: repoMemories.key,
				content: repoMemories.content,
				phase: repoMemories.phase
			})
			.from(repoMemories)
			.where(eq(repoMemories.repoUrl, repoUrl))
	)
	if (result.error) {
		logger.warn("failed to load repo memories", { error: result.error, repoUrl })
		return []
	}

	return result.data
}

async function upsertRepoMemory(
	db: Db,
	repoUrl: string,
	key: string,
	content: string,
	opts?: { phase?: string; runId?: string }
): Promise<void> {
	const now = new Date()

	const existing = await errors.try(
		db
			.select({ id: repoMemories.id })
			.from(repoMemories)
			.where(and(eq(repoMemories.repoUrl, repoUrl), eq(repoMemories.key, key)))
			.limit(1)
	)

	if (existing.error) {
		logger.warn("failed checking existing repo memory", { error: existing.error })
	}

	const existingRow = existing.error ? undefined : existing.data[0]

	if (existingRow) {
		const updateResult = await errors.try(
			db
				.update(repoMemories)
				.set({ content, phase: opts?.phase, runId: opts?.runId, updatedAt: now })
				.where(eq(repoMemories.id, existingRow.id))
		)
		if (updateResult.error) {
			logger.error("failed to update repo memory", { error: updateResult.error, key })
			throw errors.wrap(updateResult.error, "update repo memory")
		}
		return
	}

	const insertResult = await errors.try(
		db.insert(repoMemories).values({
			repoUrl,
			key,
			content,
			phase: opts?.phase,
			runId: opts?.runId,
			createdAt: now,
			updatedAt: now
		})
	)
	if (insertResult.error) {
		logger.error("failed to insert repo memory", { error: insertResult.error, key })
		throw errors.wrap(insertResult.error, "insert repo memory")
	}
}

function formatRepoMemoriesForPrompt(memories: RepoMemory[]): string {
	if (memories.length === 0) return ""

	const lines = ["## Repository Memory (persisted across runs)"]
	for (const m of memories) {
		const phaseTag = m.phase ? ` [${m.phase}]` : ""
		lines.push(`- **${m.key}**${phaseTag}: ${m.content}`)
	}
	return lines.join("\n")
}

export { formatRepoMemoriesForPrompt, loadRepoMemories, upsertRepoMemory }
export type { RepoMemory }
