CREATE TYPE "public"."cv_intake_batch_status" AS ENUM('OPEN', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."cv_intake_item_status" AS ENUM('PENDING_PARSE', 'PARSED', 'PARSE_FAILED', 'CONVERTED', 'DISCARDED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_intake_batch" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"label" varchar(200) NOT NULL,
	"status" "cv_intake_batch_status" DEFAULT 'OPEN' NOT NULL,
	"uploaded_by" bigint NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cv_intake_item" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batch_id" bigint NOT NULL,
	"item_id" varchar(80) NOT NULL,
	"file_name" varchar(300) NOT NULL,
	"file_hash" varchar(128) NOT NULL,
	"mime_type" varchar(200) NOT NULL,
	"file_size" bigint NOT NULL,
	"status" "cv_intake_item_status" DEFAULT 'PENDING_PARSE' NOT NULL,
	"extracted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generation" jsonb,
	"candidate_id" bigint,
	"note" text,
	CONSTRAINT "ck_cv_intake_item_size" CHECK ("cv_intake_item"."file_size" >= 0),
	CONSTRAINT "ck_cv_intake_item_converted" CHECK (("cv_intake_item"."status" = 'CONVERTED') = ("cv_intake_item"."candidate_id" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cv_intake_item" ADD CONSTRAINT "cv_intake_item_batch_id_cv_intake_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."cv_intake_batch"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cv_intake_item" ADD CONSTRAINT "cv_intake_item_candidate_id_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidate"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cv_intake_batch_tenant_status" ON "cv_intake_batch" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cv_intake_batch_uploader" ON "cv_intake_batch" USING btree ("tenant_id","uploaded_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_cv_intake_item_hash" ON "cv_intake_item" USING btree ("batch_id","file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_cv_intake_item_id" ON "cv_intake_item" USING btree ("batch_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cv_intake_item_batch_status" ON "cv_intake_item" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_cv_intake_item_hash" ON "cv_intake_item" USING btree ("file_hash");