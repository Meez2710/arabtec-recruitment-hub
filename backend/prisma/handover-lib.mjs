// ============================================================================
// Shared helpers for the production user-credential handover.
//
// Used by:
//   handover-01-audit.mjs    read-only reconciliation of the live users table
//   handover-02-rotate.mjs   generate UNIQUE temp passwords, hash, update live DB
//   handover-03-verify.mjs   re-verify every credential + data integrity
//
// No secrets in this file. It never logs a candidate password.
// ============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, all, driverKind } from '../src/lib/db.js';
import { validatePassword } from '../src/lib/passwords.js';

export const ADMIN_EMAIL = String(process.env.SEED_ADMIN_EMAIL || 'admin@arabtec.com').toLowerCase();
export const HANDOVER_DIR = process.env.HANDOVER_DIR || '/var/lib/arabtec-ats/handover';
export const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

// Temp-password requirement (task): >= 14 chars, all four character classes,
// cryptographically random, not derived from name/company/email/etc.
// We generate 16 and then run the app's OWN policy (validatePassword) against it
// with the user's identity, so a generated password would also pass a real
// first-login validation and can never contain the person's name or email.
export const TEMP_LENGTH = 16;

// Unambiguous alphabets — no 0/O/1/l/I — because these are printed and typed once.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*?-_=+';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

const pick = (set) => set[crypto.randomInt(set.length)];

export function generateTempPassword({ fullName, email } = {}) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
    while (chars.length < TEMP_LENGTH) chars.push(pick(ALL));
    // crypto Fisher–Yates so the guaranteed classes are not in fixed positions
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join('');
    // The app's own policy: >=14 here, all classes, no name / email local-part,
    // no weak fragment ("arabtec", "admin@", …), not in the common deny-list.
    if (validatePassword(pw, { minLength: 14, fullName, email }).ok) return pw;
  }
  throw new Error('generateTempPassword: no compliant candidate after 500 attempts');
}

// ---- role -> handover category -------------------------------------------------
export function categoryFor(roleCodes) {
  const s = new Set(roleCodes || []);
  if (s.has('system_admin')) return 'System Admin';
  if (s.has('hr_director') || s.has('hr_manager') || s.has('recruitment_manager') || s.has('recruiter')) {
    return 'Recruitment / HR';
  }
  if (s.has('hiring_manager') || s.has('project_manager')) {
    return 'Hiring Managers / Department Heads / Project Managers';
  }
  return 'Other active users';
}

// ---- load the roster (plain SQL only — lib/db.js does NOT translate dialect) --
export function loadRoster() {
  const users = all(`
    SELECT u.id, u.employee_no, u.full_name, u.email, u.job_title, u.status,
           u.must_change_password, u.failed_login_count, u.locked_until,
           u.password_hash, d.name AS department
    FROM users u
    LEFT JOIN department d ON d.id = u.department_id
    ORDER BY u.id`);
  const roleRows = all(`
    SELECT ur.user_id, r.code
    FROM user_role ur JOIN role r ON r.id = ur.role_id`);
  const byUser = new Map();
  for (const row of roleRows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.code);
  }
  return users.map((u) => {
    const roles = (byUser.get(u.id) || []).sort();
    return {
      id: u.id,
      employeeNo: u.employee_no || '',
      fullName: u.full_name,
      email: String(u.email || '').toLowerCase(),
      jobTitle: u.job_title || '',
      department: u.department || '',
      roles,
      roleLabel: roles.join(' + ') || '(no role)',
      category: categoryFor(roles),
      status: u.status,
      mustChangePassword: Number(u.must_change_password) === 1,
      failedLoginCount: Number(u.failed_login_count || 0),
      lockedUntil: u.locked_until || null,
      isAdmin: String(u.email || '').toLowerCase() === ADMIN_EMAIL,
      hashType: /^\$2[aby]\$/.test(u.password_hash || '') ? 'bcrypt' : 'OTHER',
      passwordHash: u.password_hash,
    };
  });
}

// ---- data-integrity checks (shared by 01 and 03) ----------------------------
const DEMO_EMAILS = [
  'hr.director@arabtec.com', 'hr.manager@arabtec.com', 'rec.manager@arabtec.com',
  'recruiter@arabtec.com', 'hiring.manager@arabtec.com', 'pm@arabtec.com',
  'interviewer@arabtec.com', 'viewer@arabtec.com',
];

export function integrityChecks(roster) {
  const out = [];
  const ck = (label, ok, detail) => out.push({ label, ok: !!ok, detail: detail || '' });

  ck('driver is postgres', driverKind() === 'postgres', `driver=${driverKind()}`);

  const emails = roster.map((u) => u.email);
  const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
  ck('email uniqueness', dupes.length === 0, dupes.length ? `dupes: ${[...new Set(dupes)].join(', ')}` : `${emails.length} unique`);

  const inactive = roster.filter((u) => u.status !== 'active');
  ck('all accounts active', inactive.length === 0, inactive.length ? `inactive: ${inactive.map((u) => u.email).join(', ')}` : `${roster.length} active`);

  const noRole = roster.filter((u) => u.roles.length === 0);
  ck('every user has >=1 role', noRole.length === 0, noRole.length ? noRole.map((u) => u.email).join(', ') : 'ok');

  const badHash = roster.filter((u) => u.hashType !== 'bcrypt');
  ck('every password_hash is bcrypt', badHash.length === 0, badHash.length ? badHash.map((u) => u.email).join(', ') : 'ok');

  const demo = roster.filter((u) => DEMO_EMAILS.includes(u.email) || /^EMP-000[2-9]$/.test(u.employeeNo));
  ck('no demo/sample users', demo.length === 0, demo.length ? demo.map((u) => u.email).join(', ') : 'none');

  const admins = roster.filter((u) => u.roles.includes('system_admin'));
  ck('exactly one system_admin', admins.length === 1, admins.map((u) => u.email).join(', ') || 'NONE');

  const roleCount = get('SELECT COUNT(*) AS c FROM role').c;
  ck('role catalog present (9)', Number(roleCount) === 9, `roles=${roleCount}`);

  const dep = get('SELECT COUNT(*) AS c FROM department').c;
  const prj = get('SELECT COUNT(*) AS c FROM project').c;
  const des = get('SELECT COUNT(*) AS c FROM designation').c;
  ck('departments = 17', Number(dep) === 17, `departments=${dep}`);
  ck('projects = 17', Number(prj) === 17, `projects=${prj}`);
  ck('designations = 459', Number(des) === 459, `designations=${des}`);

  const cand = get('SELECT COUNT(*) AS c FROM candidate').c;
  const req = get('SELECT COUNT(*) AS c FROM recruitment_request').c;
  ck('no candidates', Number(cand) === 0, `candidates=${cand}`);
  ck('no recruitment requests', Number(req) === 0, `recruitment_request=${req}`);

  const orphanDept = roster.filter((u) => u.roles.some((r) => r !== 'system_admin') && !u.department && u.category !== 'Recruitment / HR');
  ck('operational users have a department', orphanDept.length === 0, orphanDept.length ? orphanDept.map((u) => u.email).join(', ') : 'ok');

  return out;
}

// ---- output helpers --------------------------------------------------------
export function ensureHandoverDir() {
  fs.mkdirSync(HANDOVER_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(HANDOVER_DIR, 0o700); } catch { /* not owner on a re-run — fine */ }
  return HANDOVER_DIR;
}

export function writePrivate(filename, contents) {
  const full = path.join(ensureHandoverDir(), filename);
  fs.writeFileSync(full, contents, { mode: 0o600 });
  fs.chmodSync(full, 0o600);
  return full;
}

export function stamp() {
  // Callers pass no Date in scripts run normally; this is a real script (not a
  // workflow), so new Date() is fine here.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function mdTable(headers, rows) {
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}
