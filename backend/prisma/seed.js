// Seed script (node:sqlite). Idempotent: safe to run repeatedly.
// Run with: npm run seed   (uses --experimental-sqlite)
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { ensureSchema } from '../src/lib/schema.js';
import { get, run, all } from '../src/lib/db.js';
import {
  PERMISSIONS, ROLES, ROLE_PERMISSIONS, BUTTONS, DEFAULT_BRANDING,
} from '../src/lib/permissions.js';

dotenv.config();
ensureSchema();

const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const upsertById = {};

function log(msg) { console.log('  ✓ ' + msg); }

async function main() {
  console.log('🌱 Seeding Arabtec Recruitment Hub (Phase 1)...');

  // 1. Permissions
  for (const [code, resource, action, description] of PERMISSIONS) {
    const ex = get('SELECT id FROM permission WHERE code=?', [code]);
    if (ex) run('UPDATE permission SET resource=?, action=?, description=? WHERE code=?', [resource, action, description, code]);
    else run('INSERT INTO permission (code,resource,action,description) VALUES (?,?,?,?)', [code, resource, action, description]);
  }
  log(`${PERMISSIONS.length} permissions`);

  // 2. Roles
  for (const [code, name, description] of ROLES) {
    const ex = get('SELECT id FROM role WHERE code=?', [code]);
    if (ex) run('UPDATE role SET name=?, description=? WHERE code=?', [name, description, code]);
    else run('INSERT INTO role (code,name,description,is_system) VALUES (?,?,?,1)', [code, name, description]);
  }
  log(`${ROLES.length} roles`);

  // 3. Role → permission matrix
  const permByCode = Object.fromEntries(all('SELECT id, code FROM permission').map((p) => [p.code, p.id]));
  for (const [roleCode, permCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = get('SELECT id FROM role WHERE code=?', [roleCode]);
    run('DELETE FROM role_permission WHERE role_id=?', [role.id]);
    for (const pc of permCodes) {
      if (permByCode[pc]) run('INSERT OR IGNORE INTO role_permission (role_id,permission_id) VALUES (?,?)', [role.id, permByCode[pc]]);
    }
  }
  log('role→permission mappings');

  // 4. Admin user
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@arabtec.com').toLowerCase();
  const adminPass = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  const adminHash = await bcrypt.hash(adminPass, rounds);
  let admin = get('SELECT * FROM users WHERE email=?', [adminEmail]);
  if (!admin) {
    run(`INSERT INTO users (employee_no,full_name,email,job_title,phone,password_hash,status)
         VALUES (?,?,?,?,?,?,?)`,
      ['EMP-0001', process.env.SEED_ADMIN_NAME || 'System Administrator', adminEmail,
       'System Administrator', '+20 100 000 0001', adminHash, 'active']);
    admin = get('SELECT * FROM users WHERE email=?', [adminEmail]);
  }
  const adminRole = get('SELECT id FROM role WHERE code=?', ['system_admin']);
  run('INSERT OR IGNORE INTO user_role (user_id,role_id) VALUES (?,?)', [admin.id, adminRole.id]);
  run('DELETE FROM user_scope WHERE user_id=?', [admin.id]);
  run('INSERT INTO user_scope (user_id,scope_type) VALUES (?,?)', [admin.id, 'global']);
  upsertById.admin = admin.id;
  log(`admin user: ${adminEmail}`);

  // 5. Sample users (one per role) for testing
  const samplePass = await bcrypt.hash('Arabtec@123', rounds);
  const sampleUsers = [
    ['EMP-0002', 'Layla Hassan', 'hr.director@arabtec.com', 'HR Director', 'hr_director'],
    ['EMP-0003', 'Omar Khalil', 'hr.manager@arabtec.com', 'HR Manager', 'hr_manager'],
    ['EMP-0004', 'Sara Mansour', 'rec.manager@arabtec.com', 'Recruitment Manager', 'recruitment_manager'],
    ['EMP-0005', 'Karim Adel', 'recruiter@arabtec.com', 'Recruiter', 'recruiter'],
    ['EMP-0006', 'Nadia Fouad', 'hiring.manager@arabtec.com', 'Hiring Manager', 'hiring_manager'],
    ['EMP-0007', 'Tarek Salah', 'pm@arabtec.com', 'Project Manager', 'project_manager'],
    ['EMP-0008', 'Mona Sami', 'interviewer@arabtec.com', 'Interviewer', 'interviewer'],
    ['EMP-0009', 'Hassan Ali', 'viewer@arabtec.com', 'Viewer', 'viewer'],
  ];
  for (const [empNo, name, email, title, roleCode] of sampleUsers) {
    let u = get('SELECT * FROM users WHERE email=?', [email]);
    if (!u) {
      run(`INSERT INTO users (employee_no,full_name,email,job_title,password_hash,status) VALUES (?,?,?,?,?,?)`,
        [empNo, name, email, title, samplePass, 'active']);
      u = get('SELECT * FROM users WHERE email=?', [email]);
    }
    const r = get('SELECT id FROM role WHERE code=?', [roleCode]);
    run('INSERT OR IGNORE INTO user_role (user_id,role_id) VALUES (?,?)', [u.id, r.id]);
    upsertById[roleCode] = u.id;
  }
  log(`${sampleUsers.length} sample users (password: Arabtec@123)`);

  // 6. Business units
  const buData = [['BU-EG', 'Arabtec Egypt', 'Egypt construction operations'], ['BU-INFRA', 'Infrastructure', 'Infrastructure & civil works']];
  const buId = {};
  for (const [code, name, description] of buData) {
    let bu = get('SELECT * FROM business_unit WHERE code=?', [code]);
    if (!bu) { run('INSERT INTO business_unit (code,name,description) VALUES (?,?,?)', [code, name, description]); bu = get('SELECT * FROM business_unit WHERE code=?', [code]); }
    buId[code] = bu.id;
  }

  // 7. Departments
  const deptData = [
    ['DEP-MECH', 'Mechanical Engineering'], ['DEP-CIVIL', 'Civil Engineering'],
    ['DEP-MEP', 'MEP'], ['DEP-PLAN', 'Planning'], ['DEP-QAQC', 'QA/QC'], ['DEP-HR', 'Human Resources'],
  ];
  for (const [code, name] of deptData) {
    const ex = get('SELECT id FROM department WHERE code=?', [code]);
    if (!ex) run('INSERT INTO department (code,name,business_unit_id) VALUES (?,?,?)', [code, name, buId['BU-EG']]);
  }
  log(`${deptData.length} departments`);

  // 8. Projects + sites
  const pmId = upsertById['project_manager'] || null;
  const projData = [
    ['PRJ-HILLS', 'Hills of One — New Zayed', 'Private Developer', 'New Zayed, Giza', 'active'],
    ['PRJ-ALIVA', 'Aliva — Mostakbal City', 'Mountain View', 'Mostakbal City', 'active'],
    ['PRJ-ICITY', 'I-City New Cairo — Lagoon Beach Park', 'Coldwell', 'New Cairo', 'planned'],
  ];
  const prjId = {};
  for (const [code, name, client, location, status] of projData) {
    let p = get('SELECT * FROM project WHERE code=?', [code]);
    if (!p) {
      run(`INSERT INTO project (code,name,client_name,location,status,business_unit_id,project_manager_id,start_date)
           VALUES (?,?,?,?,?,?,?,?)`,
        [code, name, client, location, status, buId['BU-EG'], pmId, '2025-01-01']);
      p = get('SELECT * FROM project WHERE code=?', [code]);
    }
    prjId[code] = p.id;
  }
  const siteData = [
    ['SITE-HILLS-A', 'Hills Zone A', 'PRJ-HILLS', 'New Zayed'],
    ['SITE-HILLS-B', 'Hills Zone B', 'PRJ-HILLS', 'New Zayed'],
    ['SITE-ALIVA-1', 'Aliva Phase 1', 'PRJ-ALIVA', 'Mostakbal City'],
  ];
  for (const [code, name, pCode, location] of siteData) {
    const ex = get('SELECT id FROM site WHERE code=?', [code]);
    if (!ex) run('INSERT INTO site (code,name,location,project_id) VALUES (?,?,?,?)', [code, name, location, prjId[pCode]]);
  }
  log(`${projData.length} projects, ${siteData.length} sites`);

  // 9. Branding
  for (const [key, value] of Object.entries(DEFAULT_BRANDING)) {
    run(`INSERT INTO branding_setting (key,value) VALUES (?,?)
         ON CONFLICT(key) DO NOTHING`, [key, String(value)]);
  }
  log(`${Object.keys(DEFAULT_BRANDING).length} branding settings`);

  // 10. Buttons
  for (const [buttonKey, label, screen, requiredPermission, confirm, reason, audit] of BUTTONS) {
    const ex = get('SELECT id FROM button_config WHERE button_key=?', [buttonKey]);
    if (!ex) run(`INSERT INTO button_config (button_key,label,screen,required_permission,confirm_required,reason_required,audit_required)
                  VALUES (?,?,?,?,?,?,?)`,
      [buttonKey, label, screen, requiredPermission, confirm ? 1 : 0, reason ? 1 : 0, audit ? 1 : 0]);
  }
  log(`${BUTTONS.length} button configs`);

  // 11. Workflow settings
  const workflows = [
    ['request_workflow', 'Recruitment Request Workflow', { states: ['Draft', 'Pending Approval', 'Budget Validation', 'Approved', 'In Sourcing', 'In Progress', 'Partially Filled', 'Filled', 'Closed'], sideStates: ['On Hold', 'Rejected', 'Cancelled', 'Expired', 'Reopened'] }],
    ['application_workflow', 'Candidate Application Workflow', { stages: ['Sourced', 'Screening', 'Shortlisted', 'Technical Interview', 'HM Feedback', 'Offer', 'Offer Sent', 'Joined'], terminals: ['Rejected', 'Withdrawn', 'Offer Declined', 'On Hold'] }],
    ['approval_chain', 'Default Approval Chain', { levels: ['Hiring/Project Manager', 'Department Head', 'HR Manager', 'Budget Validation', 'HR Director (conditional)'] }],
  ];
  for (const [key, name, value] of workflows) {
    const ex = get('SELECT id FROM workflow_setting WHERE key=?', [key]);
    if (!ex) run('INSERT INTO workflow_setting (key,name,value) VALUES (?,?,?)', [key, name, JSON.stringify(value)]);
  }
  log(`${workflows.length} workflow settings`);

  // 12. System settings
  const sys = [['ticket_prefix', 'REQ'], ['candidate_prefix', 'CAN'], ['application_prefix', 'APP'], ['interview_prefix', 'INT'], ['offer_prefix', 'OFR'], ['session_timeout_minutes', '120'], ['password_min_length', '8'], ['mfa_required', 'false'], ['default_currency', 'EGP'], ['request_counter', '0'], ['candidate_counter', '0'], ['application_counter', '0'], ['interview_counter', '0'], ['offer_counter', '0'], ['sla_approval_hours', '48'], ['sla_sourcing_days', '5'], ['salary_band_max_threshold', '50000'], ['director_approval_headcount', '10'], ['offer_director_threshold', '50000'], ['allow_duplicate_application', 'false'], ['health_amber_days', '30'], ['health_red_days', '45']];
  for (const [key, value] of sys) run('INSERT INTO system_setting (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING', [key, value]);
  log(`${sys.length} system settings`);

  // 14. Reject reasons
  const rejectReasons = [
    ['insufficient_experience', 'Insufficient experience'],
    ['wrong_discipline', 'Wrong discipline'],
    ['weak_interview', 'Weak interview performance'],
    ['salary_mismatch', 'Salary mismatch'],
    ['unavailable', 'Unavailable'],
    ['notice_too_long', 'Notice period too long'],
    ['no_project_fit', 'No project fit'],
    ['communication_issue', 'Communication issue'],
    ['manager_rejection', 'Manager rejection'],
    ['withdrawn_by_candidate', 'Withdrawn by candidate'],
    ['other', 'Other'],
  ];
  for (const [code, label] of rejectReasons) {
    run('INSERT INTO reject_reason (code,label) VALUES (?,?) ON CONFLICT(code) DO NOTHING', [code, label]);
  }
  log(`${rejectReasons.length} reject reasons`);

  // 13. Initial audit entry
  run(`INSERT INTO audit_log (actor_id,actor_name,actor_role,action,entity_type,entity_id,comments)
       VALUES (?,?,?,?,?,?,?)`,
    [upsertById.admin, 'System Administrator', 'system_admin', 'system.seeded', 'system', 'phase1', 'Phase 1 database seeded.']);

  console.log('✅ Seed complete.\n');
  console.log('   Admin login:  ' + adminEmail + '  /  ' + adminPass);
  console.log('   Sample users: <role>@arabtec.com  /  Arabtec@123\n');
}

export { main as seed };

// Auto-run only when invoked directly (npm run seed), not when imported for boot-seed.
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
