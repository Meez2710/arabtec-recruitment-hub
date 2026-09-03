// ============================================================================
// handover-02-rotate.mjs  —  replace the shared temporary manager password with
// a UNIQUE strong temporary password for every real (non-admin) user, hash it
// with the app's own bcrypt, update the LIVE database, verify every credential,
// and write the confidential handover files to $HANDOVER_DIR (chmod 600).
//
//   Real run (on the server, production DATABASE_URL):
//     node prisma/handover-02-rotate.mjs
//
//   Dry run (safe anywhere — generates + hashes + verifies locally, writes
//   nothing to the DB, writes a report to $HANDOVER_DIR only):
//     node prisma/handover-02-rotate.mjs --dry-run
//
// Rules enforced:
//   • System Admin (SEED_ADMIN_EMAIL, default admin@arabtec.com) is NEVER touched.
//   • Each new password: 16 chars, all four classes, crypto-random, and it must
//     pass the app's own validatePassword() for that user (so it can never
//     contain their name or email).
//   • For every rotated user:  must_change_password = 1,
//     failed_login_count = 0,  locked_until = NULL.
//   • The run FAILS (exit 1) unless every credential verifies X/X.
//   • Passwords are written ONLY to the chmod-600 files in $HANDOVER_DIR.
//     They are never printed to stdout and never written inside the repo.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { ensureSchema } from '../src/lib/schema.js';
import { get, tx, driverKind } from '../src/lib/db.js';
import { Users } from '../src/lib/models.js';
import {
  loadRoster, integrityChecks, generateTempPassword, ROUNDS, ADMIN_EMAIL,
  writePrivate, ensureHandoverDir, stamp, mdTable, HANDOVER_DIR,
} from './handover-lib.mjs';

dotenv.config();
ensureSchema();

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(`handover-02-rotate  (${DRY ? 'DRY RUN — no database writes' : 'LIVE — will update the production database'})`);
console.log(`  driver=${driverKind()}  bcrypt rounds=${ROUNDS}  handover dir=${HANDOVER_DIR}\n`);

if (!DRY && driverKind() !== 'postgres') {
  console.error('REFUSING: not connected to PostgreSQL. Run on the server with the production DATABASE_URL, or use --dry-run.');
  process.exit(2);
}

// ---- 1. audit + integrity gate -------------------------------------------
const roster = loadRoster();
const checks = integrityChecks(roster);
// In --dry-run the connection is intentionally not the production Postgres, so
// that specific check is allowed to fail; every other check still gates.
const failedChecks = checks.filter((c) => !c.ok && !(DRY && c.label === 'driver is postgres'));
console.log('Integrity gate:');
for (const c of checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? '  (' + c.detail + ')' : ''}`);
if (failedChecks.length && !FORCE) {
  console.error(`\nREFUSING: ${failedChecks.length} integrity check(s) failed. Fix them, or re-run with --force if you have reviewed each one.`);
  process.exit(1);
}

const targets = roster.filter((u) => !u.isAdmin && u.status === 'active');
const skipped = roster.filter((u) => u.isAdmin || u.status !== 'active');
console.log(`\nWill rotate ${targets.length} account(s). Untouched: ${skipped.map((u) => u.email).join(', ') || '(none)'}\n`);
if (!targets.length) { console.error('Nothing to do.'); process.exit(1); }

// ---- 2. generate unique passwords + hashes (in memory) -----------------
const seen = new Set();
const batch = targets.map((u) => {
  let pw;
  do { pw = generateTempPassword({ fullName: u.fullName, email: u.email }); } while (seen.has(pw));
  seen.add(pw);
  const hash = bcrypt.hashSync(pw, ROUNDS);
  // local sanity: the hash we are about to store must verify against the plaintext
  if (!bcrypt.compareSync(pw, hash)) throw new Error(`local hash self-check failed for ${u.email}`);
  return { user: u, password: pw, hash };
});
console.log(`Generated ${batch.length} unique passwords; all self-verified locally.`);

// ---- 3. apply to the live DB (single transaction) ---------------------
if (DRY) {
  console.log('\n[dry-run] skipping database UPDATE.');
} else {
  tx(() => {
    for (const b of batch) {
      Users.setPasswordForceChange(b.user.id, b.hash); // password_hash + must_change_password=1
      Users.clearFailedLogins(b.user.id);              // failed_login_count=0, locked_until=NULL
    }
  });
  console.log(`\nApplied ${batch.length} updates in one transaction.`);
}

// ---- 4. verify EVERY credential against the stored hash --------------
let pass = 0;
const mismatches = [];
for (const b of batch) {
  let stored = b.hash;
  if (!DRY) {
    const row = get('SELECT password_hash, must_change_password, failed_login_count, locked_until FROM users WHERE id=?', [b.user.id]);
    stored = row?.password_hash;
    const flagsOk = Number(row?.must_change_password) === 1
      && Number(row?.failed_login_count) === 0
      && (row?.locked_until === null || row?.locked_until === undefined);
    if (!flagsOk) mismatches.push(`${b.user.email} (flags: mcp=${row?.must_change_password} flc=${row?.failed_login_count} locked=${row?.locked_until})`);
  }
  if (stored && bcrypt.compareSync(b.password, stored)) pass++;
  else mismatches.push(`${b.user.email} (hash mismatch)`);
}
console.log(`\ncredential verification: ${pass}/${batch.length} ${mismatches.length ? 'FAIL' : 'PASS'}`);
if (mismatches.length) {
  console.error('MISMATCHES:\n  ' + mismatches.join('\n  '));
  console.error('\nDo NOT distribute. Investigate before proceeding.');
  process.exit(1);
}

// ---- 5. write the confidential handover files (chmod 600) ------------
ensureHandoverDir();
const ts = stamp();
const URL = process.env.ATS_PUBLIC_URL || 'http://10.20.0.9:4001';

const rows = batch
  .slice()
  .sort((a, b) => a.user.category.localeCompare(b.user.category) || a.user.fullName.localeCompare(b.user.fullName))
  .map((b) => [
    b.user.fullName, b.user.email, b.user.jobTitle || '—', b.user.department || '—',
    b.user.roleLabel, b.password, 'Password change required',
  ]);

const header = `# Arabtec Recruitment Hub — Temporary User Credentials

> **INTERNAL — CONFIDENTIAL.** Temporary credentials for first login only.
> Each user MUST change their password at first login. Do NOT forward externally.
>
> - System URL: ${URL}
> - Generated: ${new Date().toISOString()}
> - Accounts: ${batch.length}   |   Verification: ${pass}/${batch.length} PASS
> - The System Admin account is not listed and was not changed.

`;
const credMd = header + mdTable(
  ['Full Name', 'Email', 'Job Title', 'Department', 'ATS Role', 'Temporary Password', 'First Login'],
  rows,
) + '\n';
const credFile = writePrivate(`temporary-credentials-${ts}.md`, credMd);

const csv = 'Full Name,Email,Job Title,Department,ATS Role,Temporary Password,First Login\n'
  + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
const csvFile = writePrivate(`temporary-credentials-${ts}.csv`, csv);

// machine-readable map for handover-03-verify.mjs (plaintext — 600, never leaves the box, gitignored)
const mapFile = writePrivate(`credentials-map-${ts}.json`, JSON.stringify({
  generatedAt: new Date().toISOString(), dryRun: DRY, url: URL,
  accounts: batch.map((b) => ({ id: b.user.id, email: b.user.email, password: b.password })),
}, null, 2));

// ---- 6. private handover manual = sanitized repo manual + credential appendix
let manualFile = null;
try {
  const repoManual = fs.readFileSync(path.join(__dirname, '..', '..', 'SYSTEM_USER_MANUAL.md'), 'utf8');
  const appendix = `\n\n---\n\n# Appendix Z — Confidential temporary credentials\n\n`
    + `> This appendix exists ONLY in the private handover copy. Do not commit or forward.\n\n`
    + mdTable(
      ['Full Name', 'Email', 'Job Title', 'Department', 'ATS Role', 'Temporary Password', 'First Login'],
      rows,
    ) + '\n';
  manualFile = writePrivate(`Arabtec_ATS_User_Manual_Internal_Handover-${ts}.md`, repoManual + appendix);
} catch (e) {
  console.log(`(private manual not generated: ${e.message})`);
}

console.log('\nWrote (chmod 600, in ' + HANDOVER_DIR + '):');
for (const f of [credFile, csvFile, mapFile, manualFile].filter(Boolean)) console.log('  ' + f);
console.log(`\n${DRY ? 'DRY RUN complete — nothing was written to the database.' : 'ROTATION complete.'}`);
console.log('Distribute the .md/.csv/private-manual via an approved internal channel only. Then delete credentials-map-*.json once every user has logged in and rotated.');
