CREATE TYPE "public"."candidate_match_status" AS ENUM('SUGGESTED', 'DISMISSED', 'LINKED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_match" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"requisition_id" bigint NOT NULL,
	"candidate_id" bigint NOT NULL,
	"score" numeric(4, 3) NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" varchar(80) NOT NULL,
	"generation" jsonb,
	"status" "candidate_match_status" DEFAULT 'SUGGESTED' NOT NULL,
	"application_id" bigint,
	"resolved_by" bigint,
	"resolved_at" timestamp with time zone,
	"reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_candidate_match_score" CHECK ("candidate_match"."score" >= 0 AND "candidate_match"."score" <= 1),
	CONSTRAINT "ck_candidate_match_link" CHECK (("candidate_match"."status" = 'LINKED') = ("candidate_match"."application_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_candidate_match_pair" ON "candidate_match" USING btree ("requisition_id","candidate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_match_requisition" ON "candidate_match" USING btree ("requisition_id","status","score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_match_candidate" ON "candidate_match" USING btree ("tenant_id","candidate_id");