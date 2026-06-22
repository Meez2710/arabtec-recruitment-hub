// DDL for Phase 1. Mirrors prisma/schema.prisma. Kept ANSI-friendly so the same
// structure ports to PostgreSQL (swap AUTOINCREMENT→SERIAL/IDENTITY, DATETIME→TIMESTAMPTZ,
// INTEGER booleans→BOOLEAN). See docs/SCHEMA.sql for the Postgres variant.
import { exec, all, run, driverKind } from './db.js';

// Idempotent additive migration: add a column only if it doesn't already exist.
// Works on both engines (SQLite PRAGMA vs Postgres information_schema).
function addColumnIfMissing(table, column, definition) {
  try {
    let cols;
    if (driverKind() === 'sqlite') {
      cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
    } else {
      cols = all(`SELECT column_name FROM information_schema.columns WHERE table_name = ?`, [table]).map((c) => c.column_name);
    }
    if (!cols.includes(column)) run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) { /* table may not exist yet on first boot; CREATE handles it */ }
}

export function ensureSchema() {
  exec(`
  CREATE TABLE IF NOT EXISTS business_unit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS department (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    head_user_id INTEGER,
    business_unit_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_no TEXT UNIQUE,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    job_title TEXT,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    department_id INTEGER REFERENCES department(id),
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    client_name TEXT,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    start_date TEXT,
    end_date TEXT,
    project_manager_id INTEGER REFERENCES users(id),
    business_unit_id INTEGER REFERENCES business_unit(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS site (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    location TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    site_manager_id INTEGER REFERENCES users(id),
    project_id INTEGER NOT NULL REFERENCES project(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS role (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS permission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS role_permission (
    role_id INTEGER NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  );

  CREATE TABLE IF NOT EXISTS user_role (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES role(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS user_scope (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL,
    project_id INTEGER REFERENCES project(id),
    site_id INTEGER REFERENCES site(id),
    ref_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    ip TEXT,
    user_agent TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS branding_setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS button_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    button_key TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    screen TEXT NOT NULL DEFAULT 'global',
    visible INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    required_permission TEXT,
    allowed_roles TEXT,
    confirm_required INTEGER NOT NULL DEFAULT 0,
    reason_required INTEGER NOT NULL DEFAULT 0,
    audit_required INTEGER NOT NULL DEFAULT 1,
    variant TEXT NOT NULL DEFAULT 'primary',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workflow_setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS system_setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    old_value TEXT,
    new_value TEXT,
    comments TEXT,
    ip TEXT,
    user_agent TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
  CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);
  CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);

  -- ===================== Phase 2: Recruitment Requests =====================
  CREATE TABLE IF NOT EXISTS recruitment_request (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    business_unit_id INTEGER REFERENCES business_unit(id),
    project_id INTEGER REFERENCES project(id),
    site_id INTEGER REFERENCES site(id),
    department_id INTEGER REFERENCES department(id),
    requester_id INTEGER REFERENCES users(id),
    owner_id INTEGER REFERENCES users(id),          -- assigned recruiter
    employment_type TEXT NOT NULL DEFAULT 'permanent',
    discipline TEXT,
    staff_category TEXT NOT NULL DEFAULT 'staff',    -- staff | manpower | bulk
    headcount INTEGER NOT NULL DEFAULT 1,
    headcount_filled INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',          -- low|medium|high|critical
    grade TEXT,
    salary_band_min REAL,
    salary_band_max REAL,
    currency TEXT DEFAULT 'EGP',
    budget_status TEXT NOT NULL DEFAULT 'pending',    -- pending|validated|rejected
    budget_note TEXT,
    justification TEXT,
    job_description TEXT,
    required_skills TEXT,                             -- JSON array
    target_join_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',             -- workflow state code
    sla_due_at TEXT,
    sla_breached INTEGER NOT NULL DEFAULT 0,
    close_reason TEXT,
    opened_at TEXT,                                    -- = approval/active date
    closed_at TEXT,
    -- enhancement: lifecycle milestone dates + intake extras
    posting_date TEXT,                                 -- job posting date
    first_candidate_at TEXT,
    first_shortlist_at TEXT,
    first_interview_at TEXT,
    first_offer_at TEXT,
    key_requirements TEXT,                             -- manual key requirements (when no JD upload)
    hiring_manager_notes TEXT,
    -- restructure (Arabtec ticket): simplified intake fields (justification column already exists above)
    location TEXT,
    key_responsibilities TEXT,
    hiring_manager_id INTEGER REFERENCES users(id),
    attachment_path TEXT,                              -- request-level JD/attachment (real file)
    attachment_name TEXT,
    version INTEGER NOT NULL DEFAULT 1,               -- optimistic locking
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS requisition_seat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    seat_no INTEGER NOT NULL,
    site_id INTEGER REFERENCES site(id),
    status TEXT NOT NULL DEFAULT 'open',              -- open|reserved|filled|cancelled|reopened
    filled_by_application_id INTEGER,
    filled_at TEXT,
    cancel_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_approval (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    level INTEGER NOT NULL,
    name TEXT NOT NULL,
    role_code TEXT,
    approver_id INTEGER REFERENCES users(id),
    decision TEXT NOT NULL DEFAULT 'pending',         -- pending|approved|rejected|returned|skipped
    comment TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    type TEXT NOT NULL,                               -- created|status_changed|approved|rejected|assigned|comment|budget|...
    from_status TEXT,
    to_status TEXT,
    note TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_req_status ON recruitment_request(status);
  CREATE INDEX IF NOT EXISTS idx_req_owner ON recruitment_request(owner_id);
  CREATE INDEX IF NOT EXISTS idx_req_project ON recruitment_request(project_id);
  CREATE INDEX IF NOT EXISTS idx_seat_request ON requisition_seat(request_id);
  CREATE INDEX IF NOT EXISTS idx_appr_request ON request_approval(request_id);
  CREATE INDEX IF NOT EXISTS idx_ract_request ON request_activity(request_id);

  -- ===================== Phase 3: Candidates & Applications =====================
  -- CRITICAL SEPARATION: candidate has NO application status.
  -- Status lives ONLY on the application (candidate ↔ request link).
  CREATE TABLE IF NOT EXISTS candidate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_no TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    nationality TEXT,
    location TEXT,
    linkedin_url TEXT,
    current_company TEXT,
    current_position TEXT,
    years_experience REAL,
    expected_salary REAL,                              -- restricted field
    notice_period TEXT,
    source TEXT,
    employer TEXT,                                     -- enhancement: current employer (distinct from current_company label)
    current_project TEXT,                              -- enhancement
    graduation_year INTEGER,                           -- enhancement
    university TEXT,                                   -- enhancement
    major TEXT,                                        -- enhancement
    tags TEXT,                                         -- JSON array
    owner_recruiter_id INTEGER REFERENCES users(id),
    candidate_state TEXT NOT NULL DEFAULT 'active',    -- active|do_not_contact|blacklisted|merged|erased (NOT application status)
    dedup_email TEXT, dedup_phone TEXT, dedup_linkedin TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS candidate_document (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL DEFAULT 'cv',               -- cv|certificate|portfolio|attachment
    file_name TEXT NOT NULL,
    file_hash TEXT,                                     -- for CV-hash dedup
    file_size INTEGER,
    note TEXT,
    uploaded_by INTEGER REFERENCES users(id),
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS application (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_no TEXT UNIQUE NOT NULL,
    candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    position_applied TEXT,
    status TEXT NOT NULL DEFAULT 'applied',            -- application status (see STATUSES)
    match_score INTEGER,
    recruiter_id INTEGER REFERENCES users(id),
    source TEXT,
    stage_date TEXT,                                    -- current stage date
    last_activity_at TEXT,
    next_action TEXT,                                   -- enhancement: recruiter next action
    next_action_date TEXT,                             -- enhancement
    interview_outcome TEXT,                             -- enhancement: latest interview outcome (denormalized convenience)
    rejection_reason TEXT,
    on_hold_reason TEXT,
    withdrawn_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id),
    UNIQUE(candidate_id, request_id)                   -- one application per candidate per request
  );

  CREATE TABLE IF NOT EXISTS application_stage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    moved_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS candidate_note (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
    application_id INTEGER REFERENCES application(id) ON DELETE SET NULL,
    note_type TEXT NOT NULL DEFAULT 'note',            -- note|assessment
    body TEXT NOT NULL,
    author_id INTEGER REFERENCES users(id),
    author_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS candidate_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER REFERENCES candidate(id) ON DELETE CASCADE,
    application_id INTEGER REFERENCES application(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    type TEXT NOT NULL,
    note TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reject_reason (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_cand_name ON candidate(full_name);
  CREATE INDEX IF NOT EXISTS idx_cand_dedup_email ON candidate(dedup_email);
  CREATE INDEX IF NOT EXISTS idx_cand_dedup_phone ON candidate(dedup_phone);
  CREATE INDEX IF NOT EXISTS idx_app_request ON application(request_id);
  CREATE INDEX IF NOT EXISTS idx_app_candidate ON application(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_app_status ON application(status);
  CREATE INDEX IF NOT EXISTS idx_ash_app ON application_stage_history(application_id);

  -- ===================== Phase 4: Interviews & Feedback =====================
  -- An interview ALWAYS links to application + candidate + request.
  -- interview.status is a SEPARATE lifecycle and never replaces application.status.
  CREATE TABLE IF NOT EXISTS interview (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_no TEXT UNIQUE NOT NULL,
    application_id INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    round INTEGER NOT NULL DEFAULT 1,
    interview_type TEXT NOT NULL DEFAULT 'technical', -- phone|technical|client|final|hr|reference
    mode TEXT NOT NULL DEFAULT 'onsite',              -- onsite|video|phone
    scheduled_at TEXT,
    duration_min INTEGER DEFAULT 60,
    location_or_link TEXT,
    organizer_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'scheduled',         -- scheduled|completed|no_show|cancelled|rescheduled
    cancel_reason TEXT,
    overall_outcome TEXT,                             -- aggregate recommendation (derived from feedback), NOT application status
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS interview_panel (
    interview_id INTEGER NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
    interviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_lead INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (interview_id, interviewer_id)
  );

  CREATE TABLE IF NOT EXISTS interview_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
    interviewer_id INTEGER NOT NULL REFERENCES users(id),
    criteria TEXT,                                    -- JSON: [{criterion, score}]
    overall_score REAL,
    recommendation TEXT,                              -- strong_yes|yes|no|strong_no
    comments TEXT,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(interview_id, interviewer_id)              -- one feedback per interviewer per interview
  );

  CREATE TABLE IF NOT EXISTS interview_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interview_id INTEGER NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    type TEXT NOT NULL,
    note TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_iv_application ON interview(application_id);
  CREATE INDEX IF NOT EXISTS idx_iv_request ON interview(request_id);
  CREATE INDEX IF NOT EXISTS idx_iv_candidate ON interview(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_ivp_interviewer ON interview_panel(interviewer_id);
  CREATE INDEX IF NOT EXISTS idx_ivf_interview ON interview_feedback(interview_id);

  -- ===================== Phase 5: Offers & Joining =====================
  -- An offer ALWAYS links to application + candidate + request.
  -- offer.status is a SEPARATE lifecycle; application stage changes are explicit/controlled.
  CREATE TABLE IF NOT EXISTS offer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_no TEXT UNIQUE NOT NULL,
    application_id INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    position_title TEXT,
    salary_offered REAL,                              -- restricted field
    currency TEXT DEFAULT 'EGP',
    benefits TEXT,                                     -- JSON or text
    joining_date TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'draft',              -- offer lifecycle (see OFFER_STATUSES)
    prepared_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    sent_at TEXT,
    accepted_at TEXT,
    rejected_at TEXT,
    rejection_reason TEXT,                             -- candidate rejection
    withdrawal_reason TEXT,
    joined_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,                -- optimistic locking
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS offer_approval (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    level INTEGER NOT NULL,
    name TEXT NOT NULL,
    role_code TEXT,
    approver_id INTEGER REFERENCES users(id),
    decision TEXT NOT NULL DEFAULT 'pending',          -- pending|approved|rejected
    comment TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS offer_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL REFERENCES offer(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id),
    actor_name TEXT,
    type TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    note TEXT,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_offer_application ON offer(application_id);
  CREATE INDEX IF NOT EXISTS idx_offer_request ON offer(request_id);
  CREATE INDEX IF NOT EXISTS idx_offer_candidate ON offer(candidate_id);
  CREATE INDEX IF NOT EXISTS idx_offer_status ON offer(status);
  CREATE INDEX IF NOT EXISTS idx_offappr_offer ON offer_approval(offer_id);
  `);

  // ---- Enhancement (Workspace release): additive migrations for existing DBs ----
  // candidate — HR-leadership-requested fields
  addColumnIfMissing('candidate', 'employer', 'TEXT');
  addColumnIfMissing('candidate', 'current_project', 'TEXT');
  addColumnIfMissing('candidate', 'graduation_year', 'INTEGER');
  addColumnIfMissing('candidate', 'university', 'TEXT');
  addColumnIfMissing('candidate', 'major', 'TEXT');
  // application — workspace tracking fields
  addColumnIfMissing('application', 'next_action', 'TEXT');
  addColumnIfMissing('application', 'next_action_date', 'TEXT');
  addColumnIfMissing('application', 'interview_outcome', 'TEXT');
  // recruitment_request — lifecycle dates + intake extras
  addColumnIfMissing('recruitment_request', 'posting_date', 'TEXT');
  addColumnIfMissing('recruitment_request', 'first_candidate_at', 'TEXT');
  addColumnIfMissing('recruitment_request', 'first_shortlist_at', 'TEXT');
  addColumnIfMissing('recruitment_request', 'first_interview_at', 'TEXT');
  addColumnIfMissing('recruitment_request', 'first_offer_at', 'TEXT');
  addColumnIfMissing('recruitment_request', 'key_requirements', 'TEXT');
  addColumnIfMissing('recruitment_request', 'hiring_manager_notes', 'TEXT');
  // restructure: simplified intake fields
  addColumnIfMissing('recruitment_request', 'location', 'TEXT');
  addColumnIfMissing('recruitment_request', 'key_responsibilities', 'TEXT');
  addColumnIfMissing('recruitment_request', 'hiring_manager_id', 'INTEGER');
  addColumnIfMissing('recruitment_request', 'prev_status', 'TEXT'); // remembered state when put On Hold (resume target)
  addColumnIfMissing('recruitment_request', 'attachment_path', 'TEXT');
  addColumnIfMissing('recruitment_request', 'attachment_name', 'TEXT');
  // candidate resume real-file path + document storage path
  addColumnIfMissing('candidate', 'resume_path', 'TEXT');
  addColumnIfMissing('candidate', 'resume_name', 'TEXT');
  addColumnIfMissing('candidate_document', 'stored_path', 'TEXT');

  // ---- Interview assessment (Arabtec form): two evaluations per application + shared final decision ----
  exec(`
  CREATE TABLE IF NOT EXISTS application_assessment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES application(id) ON DELETE CASCADE,
    evaluator_type TEXT NOT NULL,                 -- hr | technical
    evaluator_id INTEGER REFERENCES users(id),
    evaluator_name TEXT,
    behavioral TEXT,                              -- JSON: {openness, conscientiousness, extraversion, agreeableness, emotional_stability:{score,notes}}
    technical TEXT,                               -- JSON: {technical_knowledge, relevant_experience, problem_solving, tools_software, planning_organizing:{score,notes}}
    critical_flags TEXT,                          -- JSON: {blaming, no_examples, cv_inconsistency}
    recommendation TEXT,                          -- proceed | proceed_conditions | hold | cv_pool | reject
    behavioral_fit TEXT,                          -- strong | acceptable | borderline | weak
    technical_fit TEXT,
    behavioral_justification TEXT,
    technical_justification TEXT,
    submitted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(application_id, evaluator_type)        -- one HR + one technical per candidate application
  );

  CREATE TABLE IF NOT EXISTS application_final_decision (
    application_id INTEGER PRIMARY KEY REFERENCES application(id) ON DELETE CASCADE,
    decision TEXT,                                -- proceed | hold | reject | hired
    decided_by INTEGER REFERENCES users(id),
    decided_by_name TEXT,
    notes TEXT,
    decided_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_assess_app ON application_assessment(application_id);

  -- ---- Ticket thread (email-style conversation on each recruitment request) ----
  CREATE TABLE IF NOT EXISTS ticket_post (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES recruitment_request(id) ON DELETE CASCADE,
    parent_post_id INTEGER REFERENCES ticket_post(id) ON DELETE CASCADE,  -- reply nesting
    post_type TEXT NOT NULL DEFAULT 'message',   -- message | file | cv | feedback | system
    author_id INTEGER REFERENCES users(id),
    author_name TEXT,
    author_role TEXT,
    body TEXT,                                   -- message text / system text / feedback summary
    file_path TEXT,                              -- stored filename (uploads dir)
    file_name TEXT,                              -- original filename
    candidate_id INTEGER REFERENCES candidate(id) ON DELETE SET NULL,   -- cv/feedback posts
    application_id INTEGER REFERENCES application(id) ON DELETE SET NULL,
    payload TEXT,                                -- JSON for structured posts (feedback scores, status change)
    edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ticketpost_req ON ticket_post(request_id);
  CREATE INDEX IF NOT EXISTS idx_ticketpost_parent ON ticket_post(parent_post_id);

  -- ---- Durable file storage: uploaded file bytes kept IN the database so they
  -- survive redeploys on hosts without a persistent disk (e.g. Render free tier).
  -- Keyed by the same stored_name the rest of the app already references.
  CREATE TABLE IF NOT EXISTS file_blob (
    stored_name TEXT PRIMARY KEY,
    original_name TEXT,
    mime TEXT,
    size INTEGER,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ---- Super-admin UI control: built-in field visibility per form ----
  -- One row per (form, field). Absent row = field shown with its default settings.
  CREATE TABLE IF NOT EXISTS field_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form TEXT NOT NULL,            -- request | candidate | offer | interview
    field_key TEXT NOT NULL,       -- e.g. linkedinUrl, noticePeriod
    label TEXT,                    -- optional relabel
    visible INTEGER NOT NULL DEFAULT 1,
    required INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(form, field_key)
  );

  -- ---- Super-admin UI control: custom fields the admin invents ----
  CREATE TABLE IF NOT EXISTS custom_field (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,          -- request | candidate
    field_key TEXT NOT NULL,       -- machine key, unique per entity
    label TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text', -- text|textarea|number|date|select|checkbox
    options TEXT,                  -- JSON array for select
    required INTEGER NOT NULL DEFAULT 0,
    visible INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity, field_key)
  );
  -- Stored values for custom fields, one row per (entity,record,field).
  CREATE TABLE IF NOT EXISTS custom_field_value (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    field_key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity, record_id, field_key)
  );
  CREATE INDEX IF NOT EXISTS idx_cfv_record ON custom_field_value(entity, record_id);
  `);

  migrateWorkflowStages();
}

// One-time, idempotent migration: rewrite any legacy request/application status
// values to the simplified Phase 0 vocabulary. Safe to run on every boot.
function migrateWorkflowStages() {
  const reqMap = {
    draft: 'pending_approval', budget_validation: 'pending_approval',
    approved: 'sourcing', in_sourcing: 'sourcing',
  };
  for (const [oldS, newS] of Object.entries(reqMap)) {
    try { run('UPDATE recruitment_request SET status=? WHERE status=?', [newS, oldS]); } catch {}
  }
  const appMap = {
    new: 'sourced', applied: 'sourced',
    screened: 'matched', cv_screening: 'matched',
    interview_1: 'interviewing', interview_2: 'interviewing', final_interview: 'interviewing',
    phone_interview: 'interviewing', technical_interview: 'interviewing', client_interview: 'interviewing',
    reference_check: 'waiting_feedback',
    offer_preparation: 'issuing_offer', offer_accepted: 'offer_sent',
    offer_rejected: 'offer_declined', withdrawn: 'rejected',
  };
  for (const [oldS, newS] of Object.entries(appMap)) {
    try { run('UPDATE application SET status=? WHERE status=?', [newS, oldS]); } catch {}
  }
}
