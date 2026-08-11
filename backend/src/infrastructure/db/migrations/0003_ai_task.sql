CREATE TYPE "public"."ai_task_state" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'ABSTAINED', 'FAILED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_task" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"capability" varchar(60) NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"entity_type" varchar(60),
	"entity_id" bigint,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "ai_task_state" DEFAULT 'QUEUED' NOT NULL,
	"priority" varchar(20) DEFAULT 'STANDARD' NOT NULL,
	"model_id" varchar(120),
	"prompt_version_id" varchar(120),
	"proposal_id" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"abstain_reason" text,
	"correlation_id" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_ai_task_attempts" CHECK ("ai_task"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ai_task_idempotency" ON "ai_task" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ai_task_claimable" ON "ai_task" USING btree ("next_attempt_at") WHERE state = 'QUEUED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ai_task_entity" ON "ai_task" USING btree ("tenant_id","entity_type","entity_id","created_at");