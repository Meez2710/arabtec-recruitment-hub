// Central catalog of permissions, roles, and the default role→permission matrix.
// Shared by the seed script and (for reference) the API. Editing the matrix here
// only affects fresh seeds; runtime changes are made via the Roles & Permissions admin.

export const PERMISSIONS = [
  // Dashboard
  ['dashboard.view', 'dashboard', 'view', 'View dashboard'],
  // Requests (Phase 2 functional, permissions seeded now)
  ['request.view_all', 'request', 'view_all', 'View all requests'],
  ['request.view_own', 'request', 'view_own', 'View own requests'],
  ['request.create', 'request', 'create', 'Create request'],
  ['request.edit', 'request', 'edit', 'Edit request'],
  ['request.delete', 'request', 'delete', 'Delete request'],
  ['request.submit', 'request', 'submit', 'Submit request for approval'],
  ['request.approve', 'request', 'approve', 'Approve request'],
  ['request.reject', 'request', 'reject', 'Reject request'],
  ['request.assign_recruiter', 'request', 'assign_recruiter', 'Assign recruiter'],
  ['request.budget_approve', 'request', 'budget_approve', 'Validate request budget'],
  ['request.hold', 'request', 'hold', 'Put request on hold / resume'],
  ['request.cancel', 'request', 'cancel', 'Cancel request'],
  ['request.close', 'request', 'close', 'Close request'],
  ['request.reopen', 'request', 'reopen', 'Reopen request'],
  // Candidates (Phase 2)
  ['candidate.view', 'candidate', 'view', 'View candidates'],
  ['candidate.add', 'candidate', 'add', 'Add candidate'],
  ['candidate.edit', 'candidate', 'edit', 'Edit candidate'],
  ['candidate.delete', 'candidate', 'delete', 'Delete candidate'],
  ['candidate.link', 'candidate', 'link', 'Link candidate to request'],
  ['candidate.move_stage', 'candidate', 'move_stage', 'Move candidate stage'],
  ['candidate.merge', 'candidate', 'merge', 'Merge duplicate candidates / override duplicate'],
  ['candidate.note', 'candidate', 'note', 'Add candidate notes'],
  ['application.bulk_action', 'application', 'bulk_action', 'Perform bulk application actions'],
  // Interviews (Phase 4)
  ['interview.view_all', 'interview', 'view_all', 'View all interviews'],
  ['interview.view_assigned', 'interview', 'view_assigned', 'View interviews assigned to me / in scope'],
  ['interview.schedule', 'interview', 'schedule', 'Schedule interview'],
  ['interview.edit', 'interview', 'edit', 'Reschedule / cancel interview'],
  ['interview.feedback', 'interview', 'feedback', 'Add interview feedback'],
  // Sensitive fields
  ['salary.view', 'salary', 'view', 'View salary fields'],
  ['offer.view', 'offer', 'view', 'View offer fields'],
  // Offers (Phase 5)
  ['offer.create', 'offer', 'create', 'Create offer'],
  ['offer.edit', 'offer', 'edit', 'Edit offer'],
  ['offer.approve', 'offer', 'approve', 'Approve offer'],
  ['offer.approve_director', 'offer', 'approve_director', 'Approve high-value offer (HR Director)'],
  ['offer.send', 'offer', 'send', 'Send offer'],
  ['offer.result_update', 'offer', 'result_update', 'Update offer result (accept/reject/withdraw/join)'],
  ['offer.salary_view', 'offer', 'salary_view', 'View offer salary fields'],
  ['offer.salary_edit', 'offer', 'salary_edit', 'Edit offer salary fields'],
  // Reports
  ['report.export', 'report', 'export', 'Export reports'],
  // Admin / platform governance
  ['user.manage', 'user', 'manage', 'Manage users'],
  ['role.manage', 'role', 'manage', 'Manage roles & permissions'],
  ['branding.manage', 'branding', 'manage', 'Manage branding'],
  ['button.manage', 'button', 'manage', 'Manage button settings'],
  ['workflow.manage', 'workflow', 'manage', 'Manage workflow settings'],
  ['org.manage', 'org', 'manage', 'Manage projects/sites/departments'],
  ['system.manage', 'system', 'manage', 'Manage system settings'],
  ['audit.view', 'audit', 'view', 'View audit logs'],
];

export const ROLES = [
  ['system_admin', 'System Admin', 'Full platform configuration and governance.'],
  ['hr_director', 'HR Director', 'Executive oversight and high-level approvals.'],
  ['hr_manager', 'HR Manager', 'Recruitment policy, approvals, recruiter & offer management.'],
  ['recruitment_manager', 'Recruitment Manager', 'Owns the recruiting function; assigns recruiters.'],
  ['recruiter', 'Recruiter', 'Operates tickets: source, screen, schedule, offers.'],
  ['hiring_manager', 'Hiring Manager', 'Raises requests; reviews shortlists; gives feedback.'],
  ['project_manager', 'Project Manager', 'Raises/endorses project headcount; project visibility.'],
  ['interviewer', 'Interviewer', 'Views assigned candidates; submits scorecards.'],
  ['viewer', 'Viewer', 'Read-only reporting/audit visibility.'],
];

// Default role → permission matrix (codes). Editable at runtime via admin.
export const ROLE_PERMISSIONS = {
  system_admin: PERMISSIONS.map((p) => p[0]), // all permissions
  hr_director: [
    'dashboard.view', 'request.view_all', 'request.approve', 'request.reject',
    'request.budget_approve', 'request.cancel', 'request.close',
    'candidate.view', 'salary.view',
    'offer.view', 'offer.approve', 'offer.approve_director', 'offer.salary_view',
    'interview.view_all', 'report.export', 'audit.view', 'org.manage',
  ],
  hr_manager: [
    'dashboard.view', 'request.view_all', 'request.create', 'request.edit',
    'request.submit', 'request.approve', 'request.reject', 'request.assign_recruiter',
    'request.budget_approve', 'request.hold', 'request.cancel', 'request.close', 'request.reopen',
    'candidate.view', 'candidate.add', 'candidate.edit', 'candidate.link', 'candidate.move_stage',
    'candidate.merge', 'candidate.note', 'application.bulk_action',
    'interview.view_all', 'interview.schedule', 'interview.edit', 'interview.feedback',
    'salary.view', 'offer.view',
    'offer.create', 'offer.edit', 'offer.approve', 'offer.send', 'offer.result_update',
    'offer.salary_view', 'offer.salary_edit', 'report.export', 'audit.view', 'org.manage',
  ],
  recruitment_manager: [
    'dashboard.view', 'request.view_all', 'request.create', 'request.edit',
    'request.submit', 'request.assign_recruiter', 'request.hold', 'request.close', 'request.reopen',
    'candidate.view', 'candidate.add',
    'candidate.edit', 'candidate.link', 'candidate.move_stage', 'candidate.merge', 'candidate.note',
    'application.bulk_action',
    'interview.view_all', 'interview.schedule', 'interview.edit', 'interview.feedback',
    'salary.view', 'offer.view', 'offer.create', 'offer.edit', 'offer.send', 'offer.result_update',
    'offer.salary_view', 'offer.salary_edit', 'report.export', 'audit.view',
  ],
  recruiter: [
    'dashboard.view', 'request.view_own', 'request.create', 'request.edit', 'request.submit',
    'candidate.view', 'candidate.add', 'candidate.edit', 'candidate.link', 'candidate.move_stage',
    'candidate.note', 'application.bulk_action',
    'interview.view_all', 'interview.schedule', 'interview.edit', 'interview.feedback',
    'offer.view', 'offer.create', 'offer.edit', 'offer.result_update',
    'offer.salary_view', 'offer.salary_edit',
  ],
  hiring_manager: [
    'dashboard.view', 'request.view_own', 'request.create', 'request.edit', 'request.submit',
    'request.approve', 'candidate.view', 'candidate.note',
    'interview.view_assigned', 'interview.feedback',
    'offer.view', // can view offer status but NOT salary (no offer.salary_view)
  ],
  project_manager: [
    'dashboard.view', 'request.view_own', 'request.create', 'request.submit', 'request.approve',
    'request.budget_approve', 'candidate.view',
  ],
  interviewer: [
    'dashboard.view', 'candidate.view', 'interview.view_assigned', 'interview.feedback',
  ],
  viewer: [
    'dashboard.view', 'request.view_all', 'candidate.view',
    'interview.view_all', 'report.export', 'audit.view',
  ],
};

// Default button registry. allowedRoles null = any role holding requiredPermission.
export const BUTTONS = [
  // key, label, screen, requiredPermission, confirm, reason, audit
  ['create_request', 'Create Request', 'requests', 'request.create', false, false, true],
  ['edit_request', 'Edit Request', 'requests', 'request.edit', false, false, true],
  ['delete_request', 'Delete Request', 'requests', 'request.delete', true, true, true],
  ['submit_request', 'Submit for Approval', 'requests', 'request.submit', true, false, true],
  ['approve_request', 'Approve Request', 'requests', 'request.approve', true, false, true],
  ['reject_request', 'Reject Request', 'requests', 'request.reject', true, true, true],
  ['validate_budget', 'Validate Budget', 'requests', 'request.budget_approve', true, false, true],
  ['reject_budget', 'Reject Budget', 'requests', 'request.budget_approve', true, true, true],
  ['assign_recruiter', 'Assign Recruiter', 'requests', 'request.assign_recruiter', false, false, true],
  ['hold_request', 'Put On Hold', 'requests', 'request.hold', true, true, true],
  ['resume_request', 'Resume Request', 'requests', 'request.hold', true, false, true],
  ['cancel_request', 'Cancel Request', 'requests', 'request.cancel', true, true, true],
  ['reopen_request', 'Reopen Request', 'requests', 'request.reopen', true, true, true],
  ['add_candidate', 'Add Candidate', 'candidates', 'candidate.add', false, false, true],
  ['edit_candidate', 'Edit Candidate', 'candidates', 'candidate.edit', false, false, true],
  ['upload_cv', 'Upload CV', 'candidates', 'candidate.edit', false, false, true],
  ['import_candidates', 'Import Candidates', 'candidates', 'candidate.add', true, false, true],
  ['smart_match', 'Smart Match Candidates', 'candidates', 'candidate.view', false, false, false],
  ['link_candidate', 'Link to Request', 'candidates', 'candidate.link', false, false, true],
  ['add_note', 'Add Note', 'candidates', 'candidate.note', false, false, true],
  ['move_stage', 'Move Candidate Stage', 'pipeline', 'candidate.move_stage', false, false, true],
  ['reject_candidate', 'Reject Candidate', 'pipeline', 'candidate.move_stage', true, true, true],
  ['hold_candidate', 'Put Candidate On Hold', 'pipeline', 'candidate.move_stage', true, true, true],
  ['shortlist_candidate', 'Shortlist', 'pipeline', 'candidate.move_stage', false, false, true],
  ['send_to_hm', 'Send to Hiring Manager', 'pipeline', 'candidate.move_stage', false, false, true],
  ['schedule_interview', 'Schedule Interview', 'interviews', 'interview.schedule', false, false, true],
  ['reschedule_interview', 'Reschedule Interview', 'interviews', 'interview.edit', false, false, true],
  ['cancel_interview', 'Cancel Interview', 'interviews', 'interview.edit', true, true, true],
  ['complete_interview', 'Mark Completed', 'interviews', 'interview.edit', false, false, true],
  ['add_feedback', 'Add Feedback', 'interviews', 'interview.feedback', false, false, true],
  ['generate_offer', 'Generate Offer', 'offers', 'offer.create', false, false, true],
  ['edit_offer', 'Edit Offer', 'offers', 'offer.edit', false, false, true],
  ['submit_offer', 'Submit for Approval', 'offers', 'offer.create', true, false, true],
  ['approve_offer', 'Approve Offer', 'offers', 'offer.approve', true, false, true],
  ['reject_offer_approval', 'Reject Offer (Approver)', 'offers', 'offer.approve', true, true, true],
  ['send_offer', 'Send Offer', 'offers', 'offer.send', true, false, true],
  ['accept_offer', 'Mark Accepted', 'offers', 'offer.result_update', true, false, true],
  ['reject_offer_candidate', 'Mark Rejected by Candidate', 'offers', 'offer.result_update', true, true, true],
  ['withdraw_offer', 'Withdraw Offer', 'offers', 'offer.result_update', true, true, true],
  ['mark_joined', 'Mark as Joined', 'offers', 'offer.result_update', true, false, true],
  ['close_request', 'Close Request', 'requests', 'request.close', true, true, true],
  ['export_data', 'Export Data', 'global', 'report.export', false, false, true],
  ['import_data', 'Import Data', 'global', 'org.manage', true, false, true],
  ['bulk_update', 'Bulk Update', 'global', 'request.edit', true, false, true],
  ['bulk_reject', 'Bulk Reject', 'global', 'candidate.move_stage', true, true, true],
  ['bulk_assign', 'Bulk Assign', 'global', 'request.assign_recruiter', true, false, true],
  ['view_salary', 'View Salary', 'global', 'salary.view', false, false, true],
  ['view_confidential_notes', 'View Confidential Notes', 'global', 'candidate.view', false, false, true],
];

// Default branding tokens — minimal corporate palette (Arabtec red accent + neutrals).
export const DEFAULT_BRANDING = {
  company_name: 'Arabtec',
  logo_url: '',
  login_logo_url: '',
  sidebar_logo_url: '',
  primary_color: '#1b1f24',     // ink (headings, KPI values)
  secondary_color: '#d2232a',   // brand red accent
  accent_color: '#d2232a',
  background_color: '#f6f7f9',
  surface_color: '#ffffff',
  text_dark: '#1b1f24',
  text_gray: '#8a929c',
  border_color: '#e7eaee',
  button_color: '#d2232a',
  success_color: '#1f7a44',
  warning_color: '#b7791f',
  critical_color: '#c0392b',
  font_family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, Helvetica, Arial, sans-serif",
  border_radius: '6px',
  card_radius: '8px',
  table_density: 'comfortable', // compact | comfortable | spacious
  sidebar_mode: 'expanded', // expanded | collapsed
  dark_mode_enabled: 'false',
  // status badge colors (JSON)
  status_badge_colors: JSON.stringify({
    draft: '#6B7280', pending: '#F59E0B', approved: '#2E7D32',
    in_progress: '#1976D2', rejected: '#C62828', closed: '#003A63',
  }),
  priority_badge_colors: JSON.stringify({
    low: '#6B7280', medium: '#1976D2', high: '#F59E0B', critical: '#C62828',
  }),
};
