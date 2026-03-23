CREATE TYPE "agent"."pipeline_mode" AS ENUM('autonomous', 'supervised');--> statement-breakpoint
CREATE TABLE "agent"."repo_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_url" text NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"phase" text,
	"run_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."bot_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "agent"."bot_locks" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."bot_subscriptions" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"subscribed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."cursor_agent_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"repository" text NOT NULL,
	"ref" text NOT NULL,
	"branch_name" text,
	"agent_url" text NOT NULL,
	"pending_followup" text,
	"pending_followup_images" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."cursor_thread_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"prompt" text NOT NULL,
	"raw_message" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"message_id" text NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."prompt_phase_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository" text NOT NULL,
	"phase" text NOT NULL,
	"header" text NOT NULL,
	"content" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."prompt_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase" text NOT NULL,
	"header" text NOT NULL,
	"content" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent"."prompt_repo_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository" text NOT NULL,
	"phase" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "prompt_repo_phases_repo_phase" UNIQUE("repository","phase")
);
--> statement-breakpoint
CREATE TABLE "agent"."prompt_user_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_user_id" text NOT NULL,
	"phase" text NOT NULL,
	"header" text NOT NULL,
	"content" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "prompt_user_overrides_user_phase_header" UNIQUE("slack_user_id","phase","header")
);
--> statement-breakpoint
CREATE TABLE "agent"."prompt_user_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_user_id" text NOT NULL,
	"phase" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "prompt_user_phases_user_phase" UNIQUE("slack_user_id","phase")
);
--> statement-breakpoint
ALTER TABLE "agent"."repo_memories" ADD CONSTRAINT "repo_memories_run_id_feature_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agent"."feature_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_memories_repo_url_idx" ON "agent"."repo_memories" USING btree ("repo_url");--> statement-breakpoint
CREATE INDEX "repo_memories_repo_url_key_idx" ON "agent"."repo_memories" USING btree ("repo_url","key");