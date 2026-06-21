-- Arabtec Recruitment Hub — Phase 1 PostgreSQL DDL
-- Portable variant of src/lib/schema.js (which targets node:sqlite).
-- Use this when migrating the local SQLite build to PostgreSQL.

CREATE TABLE business_unit (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE department (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  head_user_id     BIGINT,
  business_unit_id BIGINT REFERENCES business_unit(id),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_no   TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  job_title     TEXT,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  mfa_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  department_id BIGINT REFERENCES department(id),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code               TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  client_name        TEXT,
  location           TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  start_date         DATE,
  end_date           DATE,
  project_manager_id BIGINT REFERENCES users(id),
  business_unit_id   BIGINT REFERENCES business_unit(id),
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE site (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  location        TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  site_manager_id BIGINT REFERENCES users(id),
  project_id      BIGINT NOT NULL REFERENCES project(id),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permission (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  resource    TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT
);

CREATE TABLE role_permission (
  role_id       BIGINT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_scope (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  project_id BIGINT REFERENCES project(id),
  site_id    BIGINT REFERENCES site(id),
  ref_id     BIGINT
);

CREATE TABLE session (
  id         UUID PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branding_setting (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key TEXT UNIQUE NOT NULL, value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE button_config (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  button_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  screen TEXT NOT NULL DEFAULT 'global',
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  required_permission TEXT,
  allowed_roles TEXT,
  confirm_required BOOLEAN NOT NULL DEFAULT FALSE,
  reason_required BOOLEAN NOT NULL DEFAULT FALSE,
  audit_required BOOLEAN NOT NULL DEFAULT TRUE,
  variant TEXT NOT NULL DEFAULT 'primary',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_setting (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  value JSONB NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE system_setting (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key TEXT UNIQUE NOT NULL, value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    BIGINT REFERENCES users(id),
  actor_name  TEXT,
  actor_role  TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  old_value   JSONB,
  new_value   JSONB,
  comments    TEXT,
  ip          TEXT,
  user_agent  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_occurred ON audit_log(occurred_at);
CREATE INDEX idx_audit_actor    ON audit_log(actor_id);
CREATE INDEX idx_session_token  ON session(token);
CREATE INDEX idx_user_email     ON users(email);

-- Recommended: make audit_log append-only by revoking UPDATE/DELETE from the app role.
-- REVOKE UPDATE, DELETE ON audit_log FROM arabtec_app;

-- ============================ Phase 2: Recruitment Requests ============================
CREATE TABLE recruitment_request (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_no TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  business_unit_id BIGINT REFERENCES business_unit(id),
  project_id BIGINT REFERENCES project(id),
  site_id BIGINT REFERENCES site(id),
  department_id BIGINT REFERENCES department(id),
  requester_id BIGINT REFERENCES users(id),
  owner_id BIGINT REFERENCES users(id),
  employment_type TEXT NOT NULL DEFAULT 'permanent',
  discipline TEXT,
  staff_category TEXT NOT NULL DEFAULT 'staff',
  headcount INT NOT NULL DEFAULT 1,
  headcount_filled INT NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'medium',
  grade TEXT,
  salary_band_min NUMERIC,
  salary_band_max NUMERIC,
  currency TEXT DEFAULT 'EGP',
  budget_status TEXT NOT NULL DEFAULT 'pending',
  budget_note TEXT,
  justification TEXT,
  job_description TEXT,
  required_skills JSONB,
  target_join_date DATE,
  status TEXT NOT NULL DEFAULT 'draft',
  sla_due_at TIMESTAMPTZ,
  sla_breached BOOLEAN NOT NULL DEFAULT FALSE,
  close_reason TEXT,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  posting_date TIMESTAMPTZ, first_candidate_at TIMESTAMPTZ, first_shortlist_at TIMESTAMPTZ, -- enhancement
  first_interview_at TIMESTAMPTZ, first_offer_at TIMESTAMPTZ,
  key_requirements TEXT, hiring_manager_notes TEXT,
  -- Restructure (Arabtec ticket): simplified intake. The employment_type / discipline /
  -- staff_category / grade / salary_band_* / budget_* columns above are retained as dormant
  -- columns for back-compat but are no longer written by the application.
  location TEXT, key_responsibilities TEXT,
  hiring_manager_id BIGINT REFERENCES users(id),
  attachment_path TEXT, attachment_name TEXT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id)
);

CREATE TABLE requisition_seat (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  seat_no INT NOT NULL,
  site_id BIGINT REFERENCES site(id),
  status TEXT NOT NULL DEFAULT 'open',
  filled_by_application_id BIGINT,
  filled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE request_approval (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  level INT NOT NULL, name TEXT NOT NULL, role_code TEXT,
  approver_id BIGINT REFERENCES users(id),
  decision TEXT NOT NULL DEFAULT 'pending',
  comment TEXT, decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE request_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  actor_id BIGINT REFERENCES users(id), actor_name TEXT,
  type TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================ Phase 3: Candidates & Applications ============================
-- CRITICAL: candidate has NO application status. Status lives on application only.
CREATE TABLE candidate (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_no TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL, email TEXT, phone TEXT, nationality TEXT, location TEXT,
  linkedin_url TEXT, current_company TEXT, current_position TEXT,
  years_experience NUMERIC, expected_salary NUMERIC, notice_period TEXT, source TEXT,
  employer TEXT, current_project TEXT, graduation_year INT, university TEXT, major TEXT, -- enhancement
  resume_path TEXT, resume_name TEXT, -- restructure: stored résumé
  tags JSONB,
  owner_recruiter_id BIGINT REFERENCES users(id),
  candidate_state TEXT NOT NULL DEFAULT 'active',
  dedup_email TEXT, dedup_phone TEXT, dedup_linkedin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id)
);

CREATE TABLE candidate_document (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL DEFAULT 'cv', file_name TEXT NOT NULL,
  file_hash TEXT, file_size BIGINT, stored_path TEXT, note TEXT, -- restructure: stored_path
  uploaded_by BIGINT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE application (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_no TEXT UNIQUE NOT NULL,
  candidate_id BIGINT NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  request_id BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  position_applied TEXT,
  status TEXT NOT NULL DEFAULT 'applied',         -- application status (NOT on candidate)
  match_score INT,
  recruiter_id BIGINT REFERENCES users(id),
  source TEXT, stage_date TIMESTAMPTZ, last_activity_at TIMESTAMPTZ,
  next_action TEXT, next_action_date TIMESTAMPTZ, interview_outcome TEXT, -- enhancement
  rejection_reason TEXT, on_hold_reason TEXT, withdrawn_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id),
  UNIQUE (candidate_id, request_id)               -- one application per candidate per request
);

CREATE TABLE application_stage_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT,
  actor_id BIGINT REFERENCES users(id), actor_name TEXT,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE candidate_note (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  application_id BIGINT REFERENCES application(id) ON DELETE SET NULL,
  note_type TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
  author_id BIGINT REFERENCES users(id), author_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE candidate_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_id BIGINT REFERENCES candidate(id) ON DELETE CASCADE,
  application_id BIGINT REFERENCES application(id) ON DELETE CASCADE,
  actor_id BIGINT REFERENCES users(id), actor_name TEXT,
  type TEXT NOT NULL, note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reject_reason (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE NOT NULL, label TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_app_request   ON application(request_id);
CREATE INDEX idx_app_candidate ON application(candidate_id);
CREATE INDEX idx_app_status    ON application(status);
CREATE INDEX idx_cand_dedup    ON candidate(dedup_email, dedup_phone);

-- ============================ Phase 4: Interviews & Feedback ============================
-- Every interview links to application + candidate + request.
-- interview.status is a SEPARATE lifecycle and never replaces application.status.
CREATE TABLE interview (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  interview_no TEXT UNIQUE NOT NULL,
  application_id BIGINT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  candidate_id   BIGINT NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  request_id     BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  round INT NOT NULL DEFAULT 1,
  interview_type TEXT NOT NULL DEFAULT 'technical',
  mode TEXT NOT NULL DEFAULT 'onsite',
  scheduled_at TIMESTAMPTZ,
  duration_min INT DEFAULT 60,
  location_or_link TEXT,
  organizer_id BIGINT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'scheduled',   -- interview lifecycle (NOT application status)
  cancel_reason TEXT,
  overall_outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id)
);

CREATE TABLE interview_panel (
  interview_id   BIGINT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  interviewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_lead BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (interview_id, interviewer_id)
);

CREATE TABLE interview_feedback (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  interview_id   BIGINT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  interviewer_id BIGINT NOT NULL REFERENCES users(id),
  criteria JSONB,
  overall_score NUMERIC,
  recommendation TEXT,                        -- strong_yes|yes|no|strong_no
  comments TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (interview_id, interviewer_id)       -- one feedback per interviewer per interview
);

CREATE TABLE interview_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  interview_id BIGINT NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
  actor_id BIGINT REFERENCES users(id), actor_name TEXT,
  type TEXT NOT NULL, note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_iv_application ON interview(application_id);
CREATE INDEX idx_iv_request     ON interview(request_id);
CREATE INDEX idx_iv_candidate   ON interview(candidate_id);
CREATE INDEX idx_ivp_interviewer ON interview_panel(interviewer_id);

-- ============================ Phase 5: Offers & Joining ============================
-- Every offer links to application + candidate + request. offer.status is a separate
-- lifecycle; application stage moves are explicit/controlled (not auto-overwritten).
CREATE TABLE offer (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_no TEXT UNIQUE NOT NULL,
  application_id BIGINT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  candidate_id   BIGINT NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  request_id     BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  position_title TEXT,
  salary_offered NUMERIC,
  currency TEXT DEFAULT 'EGP',
  benefits TEXT,
  joining_date DATE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  prepared_by BIGINT REFERENCES users(id),
  approved_by BIGINT REFERENCES users(id),
  sent_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ, rejected_at TIMESTAMPTZ,
  rejection_reason TEXT, withdrawal_reason TEXT, joined_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id)
);

CREATE TABLE offer_approval (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_id BIGINT NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
  level INT NOT NULL, name TEXT NOT NULL, role_code TEXT,
  approver_id BIGINT REFERENCES users(id),
  decision TEXT NOT NULL DEFAULT 'pending',
  comment TEXT, decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE offer_activity (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_id BIGINT NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
  actor_id BIGINT REFERENCES users(id), actor_name TEXT,
  type TEXT NOT NULL, from_status TEXT, to_status TEXT, note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_offer_application ON offer(application_id);
CREATE INDEX idx_offer_request     ON offer(request_id);
CREATE INDEX idx_offer_candidate   ON offer(candidate_id);
CREATE INDEX idx_offer_status      ON offer(status);

-- ============================ Restructure: Interview assessment ============================
-- One HR + one technical evaluation per application, plus a shared final decision.
CREATE TABLE application_assessment (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  evaluator_type TEXT NOT NULL,                 -- hr | technical
  evaluator_id BIGINT REFERENCES users(id), evaluator_name TEXT,
  behavioral JSONB,                             -- Big-Five {score,notes} per criterion
  technical JSONB,                              -- technical competency {score,notes} per criterion
  critical_flags JSONB,                         -- {blaming, no_examples, cv_inconsistency}
  recommendation TEXT,                          -- proceed | proceed_conditions | hold | cv_pool | reject
  behavioral_fit TEXT, technical_fit TEXT,      -- strong | acceptable | borderline | weak
  behavioral_justification TEXT, technical_justification TEXT,
  submitted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(application_id, evaluator_type)        -- one HR + one technical per application
);

CREATE TABLE application_final_decision (
  application_id BIGINT PRIMARY KEY REFERENCES application(id) ON DELETE CASCADE,
  decision TEXT,                                -- proceed | hold | reject | hired
  decided_by BIGINT REFERENCES users(id), decided_by_name TEXT,
  notes TEXT, decided_at TIMESTAMPTZ
);

CREATE INDEX idx_assess_app ON application_assessment(application_id);

-- ============================ Ticket thread (email-style conversation) ============================
CREATE TABLE ticket_post (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
  parent_post_id BIGINT REFERENCES ticket_post(id) ON DELETE CASCADE,  -- reply nesting
  post_type TEXT NOT NULL DEFAULT 'message',   -- message | file | cv | feedback | system
  author_id BIGINT REFERENCES users(id), author_name TEXT, author_role TEXT,
  body TEXT, file_path TEXT, file_name TEXT,
  candidate_id BIGINT REFERENCES candidate(id) ON DELETE SET NULL,
  application_id BIGINT REFERENCES application(id) ON DELETE SET NULL,
  payload JSONB,                               -- structured posts (feedback scores, status change)
  edited BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ticketpost_req ON ticket_post(request_id);
CREATE INDEX idx_ticketpost_parent ON ticket_post(parent_post_id);
