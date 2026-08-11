CREATE TYPE "public"."candidate_state" AS ENUM('ACTIVE', 'DO_NOT_CONTACT', 'BLACKLISTED', 'MERGED', 'ERASED');--> statement-breakpoint
CREATE TYPE "public"."candidate_document_type" AS ENUM('CV', 'CERTIFICATE', 'PORTFOLIO', 'ATTACHMENT');--> statement-breakpoint
CREATE TYPE "public"."candidate_proposal_status" AS ENUM('PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"candidate_no" varchar(40) NOT NULL,
	"full_name" varchar(200) NOT NULL,
	"email" varchar(320),
	"phone" varchar(40),
	"nationality" varchar(100),
	"location" varchar(200),
	"linkedin_url" varchar(500),
	"current_company" varchar(200),
	"current_position" varchar(200),
	"years_experience" numeric(4, 1),
	"notice_period" varchar(100),
	"university" varchar(200),
	"major" varchar(200),
	"graduation_year" integer,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"certifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" varchar(100),
	"owner_recruiter_id" bigint,
	"state" "candidate_state" DEFAULT 'ACTIVE' NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_email" varchar(320),
	"dedup_phone" varchar(40),
	"dedup_linkedin" varchar(500),
	"created_by" bigint NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_candidate_contact" CHECK ("candidate"."state" = 'ERASED' OR "candidate"."email" IS NOT NULL OR "candidate"."phone" IS NOT NULL),
	CONSTRAINT "ck_candidate_experience" CHECK ("candidate"."years_experience" IS NULL OR ("candidate"."years_experience" >= 0 AND "candidate"."years_experience" <= 70))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_document" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"candidate_id" bigint NOT NULL,
	"document_id" varchar(80) NOT NULL,
	"doc_type" "candidate_document_type" NOT NULL,
	"file_name" varchar(300) NOT NULL,
	"file_hash" varchar(128) NOT NULL,
	"file_size" bigint NOT NULL,
	"mime_type" varchar(200) NOT NULL,
	"note" text,
	"uploaded_by" bigint,
	"uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_candidate_document_size" CHECK ("candidate_document"."file_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_proposal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"candidate_id" bigint NOT NULL,
	"origin" varchar(80) NOT NULL,
	"task_id" varchar(120) DEFAULT '' NOT NULL,
	"model_id" varchar(120) DEFAULT '' NOT NULL,
	"document_id" varchar(80),
	"status" "candidate_proposal_status" DEFAULT 'PENDING' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_candidate_proposal_reviewer" CHECK ("candidate_proposal"."status" IN ('PENDING','SUPERSEDED') OR "candidate_proposal"."reviewed_by" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_document" ADD CONSTRAINT "candidate_document_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_proposal" ADD CONSTRAINT "candidate_proposal_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_candidate_no" ON "candidate" USING btree ("tenant_id","candidate_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_tenant_state" ON "candidate" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_tenant_owner" ON "candidate" USING btree ("tenant_id","owner_recruiter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_dedup_email" ON "candidate" USING btree ("tenant_id","dedup_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_dedup_phone" ON "candidate" USING btree ("tenant_id","dedup_phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_dedup_linkedin" ON "candidate" USING btree ("tenant_id","dedup_linkedin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_tenant_created" ON "candidate" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_candidate_document_hash" ON "candidate_document" USING btree ("candidate_id","file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_candidate_document_id" ON "candidate_document" USING btree ("candidate_id","document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_document_hash" ON "candidate_document" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_document_type" ON "candidate_document" USING btree ("candidate_id","doc_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_candidate_proposal_pending" ON "candidate_proposal" USING btree ("candidate_id") WHERE "candidate_proposal"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_proposal_candidate" ON "candidate_proposal" USING btree ("candidate_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_candidate_proposal_tenant_status" ON "candidate_proposal" USING btree ("tenant_id","status");--> statement-breakpoint

-- Candidate business numbers. Same rationale as migration 0001: a sequence
-- cannot collide, and a gap after a rollback is harmless.
CREATE SEQUENCE IF NOT EXISTS "seq_candidate_no" AS bigint START WITH 1 INCREMENT BY 1;
