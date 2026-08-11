CREATE TYPE "public"."application_stage" AS ENUM('SOURCED', 'MATCHED', 'INTERVIEWING', 'OFFER_PREPARATION', 'OFFER_SENT', 'HIRED', 'NOT_SUITABLE', 'ON_HOLD', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED');--> statement-breakpoint
CREATE TYPE "public"."requisition_state" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."seat_state" AS ENUM('OPEN', 'FILLED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."transition_trigger" AS ENUM('MANUAL', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."evaluator_role" AS ENUM('RECRUITER', 'HIRING_MANAGER');--> statement-breakpoint
CREATE TYPE "public"."interview_mode" AS ENUM('ONSITE', 'VIDEO', 'PHONE');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'REJECTED_BY_APPROVER');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_application" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"application_no" varchar(40) NOT NULL,
	"candidate_id" bigint NOT NULL,
	"requisition_id" bigint NOT NULL,
	"recruiter_id" bigint,
	"stage" "application_stage" NOT NULL,
	"previous_stage" "application_stage",
	"reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action" text,
	"next_action_due_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_requisition" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"ticket_no" varchar(40) NOT NULL,
	"title" varchar(200) NOT NULL,
	"project_id" bigint NOT NULL,
	"department_id" bigint NOT NULL,
	"requester_id" bigint NOT NULL,
	"recruiter_id" bigint,
	"created_by" bigint NOT NULL,
	"headcount" integer NOT NULL,
	"state" "requisition_state" NOT NULL,
	"previous_state" "requisition_state",
	"close_reason" varchar(40),
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_requisition_headcount" CHECK ("hiring_requisition"."headcount" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_seat" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"requisition_id" bigint NOT NULL,
	"seat_no" integer NOT NULL,
	"state" "seat_state" NOT NULL,
	"application_id" bigint,
	"filled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_seat_filled_binding" CHECK (("hiring_seat"."state" = 'FILLED') = ("hiring_seat"."application_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hiring_stage_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"application_id" bigint NOT NULL,
	"from_stage" "application_stage",
	"to_stage" "application_stage" NOT NULL,
	"reason" text,
	"trigger" "transition_trigger" NOT NULL,
	"actor_id" bigint,
	"actor_name" varchar(200),
	"moved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interview" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"interview_no" varchar(40) NOT NULL,
	"application_id" bigint NOT NULL,
	"candidate_id" bigint NOT NULL,
	"requisition_id" bigint NOT NULL,
	"round" integer NOT NULL,
	"mode" "interview_mode" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"location_or_link" text,
	"organiser_user_id" bigint NOT NULL,
	"status" "interview_status" NOT NULL,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"last_rescheduled_at" timestamp with time zone,
	"cancel_reason" text,
	"external_event_id" varchar(255),
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_interview_round" CHECK ("interview"."round" >= 1),
	CONSTRAINT "ck_interview_duration" CHECK ("interview"."duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interview_assessment" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"interview_id" bigint NOT NULL,
	"evaluator_user_id" bigint NOT NULL,
	"evaluator_role" "evaluator_role" NOT NULL,
	"evaluator_name" varchar(200) NOT NULL,
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"critical_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"justification" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interview_panel" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"interview_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" "evaluator_role" NOT NULL,
	"is_lead" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offer" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"offer_no" varchar(40) NOT NULL,
	"application_id" bigint NOT NULL,
	"candidate_id" bigint NOT NULL,
	"requisition_id" bigint NOT NULL,
	"position_title" varchar(200) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"joining_date" timestamp with time zone,
	"status" "offer_status" NOT NULL,
	"prepared_by" bigint NOT NULL,
	"approved_by" bigint,
	"requires_director_approval" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"reason" text,
	"template_code" varchar(60),
	"template_version" integer,
	"variable_snapshot" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_offer_approver" CHECK ("offer"."status" <> 'APPROVED' OR "offer"."approved_by" IS NOT NULL),
	CONSTRAINT "ck_offer_template_pinned" CHECK (("offer"."template_code" IS NULL) = ("offer"."template_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offer_compensation_component" (
	"code" varchar(60) PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"label_en" varchar(120) NOT NULL,
	"label_ar" varchar(120),
	"display_order" integer DEFAULT 0 NOT NULL,
	"footnote_key" varchar(60),
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offer_compensation_line" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"offer_id" bigint NOT NULL,
	"component_code" varchar(60) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "ck_comp_line_amount" CHECK ("offer_compensation_line"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"aggregate_type" varchar(60) NOT NULL,
	"aggregate_id" bigint NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"correlation_id" varchar(80),
	CONSTRAINT "ck_outbox_attempts" CHECK ("outbox_event"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_event" (
	"consumer" varchar(80) NOT NULL,
	"event_id" bigint NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timeline_entry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" integer DEFAULT 1 NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" bigint NOT NULL,
	"event_type" varchar(80) NOT NULL,
	"actor_id" bigint,
	"actor_name" varchar(200),
	"occurred_at" timestamp with time zone NOT NULL,
	"previous_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"new_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" varchar(64),
	"user_agent" text,
	"request_id" varchar(80),
	"correlation_id" varchar(80)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hiring_application" ADD CONSTRAINT "hiring_application_requisition_id_hiring_requisition_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."hiring_requisition"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hiring_seat" ADD CONSTRAINT "hiring_seat_requisition_id_hiring_requisition_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."hiring_requisition"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hiring_seat" ADD CONSTRAINT "hiring_seat_application_id_hiring_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."hiring_application"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hiring_stage_history" ADD CONSTRAINT "hiring_stage_history_application_id_hiring_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."hiring_application"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interview" ADD CONSTRAINT "interview_application_id_hiring_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."hiring_application"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interview_assessment" ADD CONSTRAINT "interview_assessment_interview_id_interview_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interview"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interview_panel" ADD CONSTRAINT "interview_panel_interview_id_interview_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interview"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offer" ADD CONSTRAINT "offer_application_id_hiring_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."hiring_application"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "offer_compensation_line" ADD CONSTRAINT "offer_compensation_line_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offer"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_application_no" ON "hiring_application" USING btree ("tenant_id","application_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_application_tenant_requisition_stage" ON "hiring_application" USING btree ("tenant_id","requisition_id","stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_application_candidate_stage" ON "hiring_application" USING btree ("candidate_id","stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_application_tenant_recruiter_due" ON "hiring_application" USING btree ("tenant_id","recruiter_id","next_action_due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_application_tenant_stage_activity" ON "hiring_application" USING btree ("tenant_id","stage","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_application_one_live_per_pair" ON "hiring_application" USING btree ("tenant_id","candidate_id","requisition_id") WHERE "hiring_application"."stage" NOT IN ('HIRED','REJECTED','WITHDRAWN','OFFER_DECLINED');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_requisition_ticket_no" ON "hiring_requisition" USING btree ("tenant_id","ticket_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_requisition_tenant_state" ON "hiring_requisition" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_requisition_tenant_recruiter_state" ON "hiring_requisition" USING btree ("tenant_id","recruiter_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_requisition_tenant_project" ON "hiring_requisition" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_requisition_tenant_requester" ON "hiring_requisition" USING btree ("tenant_id","requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_seat_requisition_seat_no" ON "hiring_seat" USING btree ("requisition_id","seat_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_seat_requisition_state" ON "hiring_seat" USING btree ("requisition_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_seat_one_per_application" ON "hiring_seat" USING btree ("application_id") WHERE "hiring_seat"."application_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_stage_history_application_moved" ON "hiring_stage_history" USING btree ("application_id","moved_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_interview_no" ON "interview" USING btree ("tenant_id","interview_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_interview_tenant_status_starts" ON "interview" USING btree ("tenant_id","status","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_interview_application" ON "interview" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_interview_tenant_candidate" ON "interview" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_interview_tenant_requisition" ON "interview" USING btree ("tenant_id","requisition_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_assessment_interview_evaluator" ON "interview_assessment" USING btree ("interview_id","evaluator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_panel_interview_user" ON "interview_panel" USING btree ("interview_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_panel_user" ON "interview_panel" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_panel_one_lead" ON "interview_panel" USING btree ("interview_id") WHERE "interview_panel"."is_lead";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_offer_no" ON "offer" USING btree ("tenant_id","offer_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_offer_tenant_status_expires" ON "offer" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_offer_application_status" ON "offer" USING btree ("application_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_offer_tenant_candidate" ON "offer" USING btree ("tenant_id","candidate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_offer_tenant_requisition" ON "offer" USING btree ("tenant_id","requisition_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_offer_one_live_per_application" ON "offer" USING btree ("application_id") WHERE "offer"."status" IN ('SENT','ACCEPTED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_comp_component_tenant_order" ON "offer_compensation_component" USING btree ("tenant_id","active","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_comp_line_offer_component" ON "offer_compensation_line" USING btree ("offer_id","component_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_outbox_pending" ON "outbox_event" USING btree ("next_attempt_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_outbox_aggregate" ON "outbox_event" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_processed_consumer_event" ON "processed_event" USING btree ("consumer","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_timeline_entity" ON "timeline_entry" USING btree ("tenant_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_timeline_actor" ON "timeline_entry" USING btree ("tenant_id","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_timeline_occurred" ON "timeline_entry" USING btree ("occurred_at");