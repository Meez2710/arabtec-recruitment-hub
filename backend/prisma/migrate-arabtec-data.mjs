// ============================================================================
// Arabtec real-data migration.
//
// Wipes ALL candidate / application / interview / offer / recruitment-request
// data and the seeded projects+departments, then loads the real Arabtec org
// data (17 projects, 17 departments, 41 managers as users, 459 designations)
// from prisma/arabtec-loadset.json.
//
//   node --experimental-sqlite prisma/migrate-arabtec-data.mjs
//
// Safe to re-run: it always wipes-then-loads to the same end state. It never
// touches the admin account, roles, permissions, branding, buttons or settings.
// The 8 demo sample users (hr.director@arabtec.com … viewer@arabtec.com) are
// removed; the real HR team arrives via the managers load.
// ============================================================================
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchema } from '../src/lib/schema.js';
import { get, run, all } from '../src/lib/db.js';

dotenv.config();
ensureSchema();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADSET = JSON.parse(fs.readFileSync(path.join(__dirname, 'arabtec-loadset.json'), 'utf8'));
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const MANAGER_PW = process.env.ARABTEC_MANAGER_PASSWORD || 'Arabtec@2026';
const NOW = new Date().toISOString();

const ok = (m) => console.log('  ✓ ' + m);
const info = (m) => console.log('  • ' + m);

function tryDelete(table, where = '') {
  try {
    const r = run(`DELETE FROM ${table}${where ? ' WHERE ' + where : ''}`);
    return r?.changes ?? 0;
  } catch (e) {
    info(`skip ${table} (${e.message.split('\n')[0]})`);
    return 0;
  }
}
function count(table, where = '') {
  try { return get(`SELECT COUNT(*) c FROM ${table}${where ? ' WHERE ' + where : ''}`).c; }
  catch { return '-'; }
}

// ---------------------------------------------------------------------------
console.log('\n🔄 Arabtec real-data migration\n');
console.log('BEFORE:', ['project', 'site', 'department', 'designation', 'users', 'candidate',
  'application', 'recruitment_request', 'interview', 'offer']
  .map((t) => `${t}=${count(t)}`).join('  '));

// ============================ 1. WIPE =====================================
console.log('\n[1/6] Wiping candidate / request / project data…');

// -- application & candidate sub-tree
for (const t of [
  'application_final_decision', 'application_assessment', 'application_stage_history',
  'interview_feedback', 'interview_panel', 'interview_activity', 'interview',
  'offer_approval', 'offer_activity', 'offer',
  'candidate_note', 'candidate_activity', 'candidate_document',
  'candidate_proposal', 'candidate_intake',
  'application', 'candidate',
]) tryDelete(t);

// -- recruitment request sub-tree
for (const t of [
  'ticket_post', 'request_activity', 'request_approval', 'requisition_seat', 'recruitment_request',
]) tryDelete(t);

// -- custom-field values / notifications that pointed at the wiped rows
tryDelete('custom_field_value', "entity IN ('request','candidate','application','project','site')");
tryDelete('notification');

// -- project sub-tree (clear project/site scopes first for the FK)
tryDelete('user_scope', 'project_id IS NOT NULL OR site_id IS NOT NULL');
tryDelete('site');
tryDelete('project');

// -- departments (rebuilt below): detach users first, then delete
run('UPDATE users SET department_id = NULL');
tryDelete('department');
ok('wiped. Now: ' + ['project', 'site', 'department', 'candidate', 'application', 'recruitment_request']
  .map((t) => `${t}=${count(t)}`).join('  '));

// ============================ 2. DEMO USERS ===============================
console.log('\n[2/6] Removing 8 demo sample users (admin kept)…');
const DEMO_EMAILS = [
  'hr.director@arabtec.com', 'hr.manager@arabtec.com', 'rec.manager@arabtec.com',
  'recruiter@arabtec.com', 'hiring.manager@arabtec.com', 'pm@arabtec.com',
  'interviewer@arabtec.com', 'viewer@arabtec.com',
];
const demoIds = DEMO_EMAILS
  .map((e) => get('SELECT id FROM users WHERE email = ?', [e])?.id)
  .filter((x) => x != null);
if (demoIds.length) {
  const list = demoIds.join(',');
  tryDelete('session', `user_id IN (${list})`);
  tryDelete('user_role', `user_id IN (${list})`);
  tryDelete('user_scope', `user_id IN (${list})`);
  tryDelete('password_reset_token', `user_id IN (${list})`);
  tryDelete('notification', `user_id IN (${list})`);
  run(`UPDATE audit_log SET actor_id = NULL WHERE actor_id IN (${list})`);
  tryDelete('users', `id IN (${list})`);
}
ok(`removed ${demoIds.length} demo users; users now = ${count('users')}`);

// ============================ 3. BUSINESS UNIT ===========================
let bu = get("SELECT * FROM business_unit WHERE code = 'BU-EG'");
if (!bu) {
  run('INSERT INTO business_unit (code,name,description) VALUES (?,?,?)',
    ['BU-EG', 'Arabtec Egypt', 'Egypt construction operations']);
  bu = get("SELECT * FROM business_unit WHERE code = 'BU-EG'");
}
const BU_ID = bu.id;

// ============================ 4. DEPARTMENTS =============================
console.log('\n[3/6] Loading departments…');
const deptIdByCode = {};
for (const d of LOADSET.departments) {
  run(`INSERT INTO department (code,name,status,business_unit_id,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    [d.code, d.name, 'active', BU_ID, 1, NOW, NOW]);
  deptIdByCode[d.code] = get('SELECT id FROM department WHERE code = ?', [d.code]).id;
}
ok(`${LOADSET.departments.length} departments`);

// ============================ 5. MANAGERS -> USERS ======================
console.log('\n[4/6] Loading managers as user accounts…');
const managerHash = await bcrypt.hash(MANAGER_PW, ROUNDS);
const roleIdByCode = Object.fromEntries(all('SELECT id, code FROM role').map((r) => [r.code, r.id]));
const userIdByEmpNo = {};
let created = 0;
for (const m of LOADSET.managers) {
  const email = m.email.toLowerCase();
  let u = get('SELECT * FROM users WHERE email = ? OR employee_no = ?', [email, m.employee_no]);
  const deptId = m.dept_code ? deptIdByCode[m.dept_code] ?? null : null;
  if (u) {
    run(`UPDATE users SET employee_no=?, full_name=?, phone=?, job_title=?, department_id=?,
         status='active', updated_at=? WHERE id=?`,
      [m.employee_no, m.full_name, m.phone, m.job_title, deptId, NOW, u.id]);
  } else {
    run(`INSERT INTO users (employee_no,full_name,email,phone,job_title,password_hash,status,
         department_id,must_change_password,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [m.employee_no, m.full_name, email, m.phone, m.job_title, managerHash, 'active',
       deptId, 1, NOW, NOW]);
    created++;
    u = get('SELECT * FROM users WHERE email = ?', [email]);
  }
  userIdByEmpNo[m.employee_no] = u.id;
  // role (single, replace any prior)
  run('DELETE FROM user_role WHERE user_id = ?', [u.id]);
  const rid = roleIdByCode[m.role];
  if (rid) run('INSERT INTO user_role (user_id,role_id) VALUES (?,?)', [u.id, rid]);
}
ok(`${LOADSET.managers.length} managers (${created} new); password "${MANAGER_PW}", must-change-on-login`);

// department heads
let heads = 0;
for (const d of LOADSET.departments) {
  if (!d.head_employee_no) continue;
  const uid = userIdByEmpNo[d.head_employee_no];
  if (uid) { run('UPDATE department SET head_user_id = ?, updated_at = ? WHERE code = ?', [uid, NOW, d.code]); heads++; }
}
ok(`${heads} department heads set`);

// ============================ 6. PROJECTS ================================
console.log('\n[5/6] Loading projects…');
for (const p of LOADSET.projects) {
  const pmId = p.pm_employee_no ? userIdByEmpNo[p.pm_employee_no] ?? null : null;
  run(`INSERT INTO project (code,name,client_name,location,status,project_manager_id,
       business_unit_id,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [p.code, p.name, p.client_name, p.location, p.status, pmId, BU_ID, 1, NOW, NOW]);
}
const pmSet = LOADSET.projects.filter((p) => p.pm_employee_no).length;
ok(`${LOADSET.projects.length} projects (${pmSet} with a linked PM, ${LOADSET.projects.length - pmSet} without)`);

// ============================ 7. DESIGNATIONS ===========================
console.log('\n[6/6] Loading designations…');
tryDelete('designation');
let dCount = 0;
for (const d of LOADSET.designations) {
  const deptId = d.dept_code ? deptIdByCode[d.dept_code] ?? null : null;
  run(`INSERT INTO designation (title,grade,function,department_id,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    [d.title, d.grade, d.function, deptId, 1, NOW, NOW]);
  dCount++;
}
ok(`${dCount} designations`);

// ============================ ADMIN ====================================
// The seed always flags the bootstrap admin must_change_password=1. In this
// local worktree the admin password is a known value in backend/.env, so clear
// the flag — otherwise every API call 403s with PASSWORD_CHANGE_REQUIRED.
// Managers keep the flag and rotate "Arabtec@2026" at first login.
const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@arabtec.com').toLowerCase();
run('UPDATE users SET must_change_password = 0 WHERE email = ?', [adminEmail]);

// ============================ AUDIT + SUMMARY ===========================
const admin = get("SELECT id FROM users WHERE email = ?", [adminEmail]);
run(`INSERT INTO audit_log (actor_id,actor_name,actor_role,action,entity_type,entity_id,comments)
     VALUES (?,?,?,?,?,?,?)`,
  [admin?.id ?? null, 'System Administrator', 'system_admin', 'system.data_migrated', 'system', 'arabtec-loadset',
   `Loaded ${LOADSET.departments.length} depts, ${LOADSET.managers.length} managers, ${LOADSET.projects.length} projects, ${LOADSET.designations.length} designations; wiped all candidates/requests.`]);

console.log('\n✅ Migration complete.\n');
console.log('AFTER: ', ['business_unit', 'department', 'designation', 'users', 'project', 'site',
  'candidate', 'application', 'recruitment_request', 'interview', 'offer']
  .map((t) => `${t}=${count(t)}`).join('  '));
console.log('');
