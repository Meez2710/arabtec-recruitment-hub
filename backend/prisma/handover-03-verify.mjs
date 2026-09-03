// ============================================================================
// handover-03-verify.mjs  —  independent re-verification of the rotated
// credentials against the LIVE database, plus a full data-integrity pass.
//
//   node prisma/handover-03-verify.mjs [path/to/credentials-map-*.json]
//
// If no path is given it picks the newest credentials-map-*.json in
// $HANDOVER_DIR. Exit code 1 if ANYTHING does not check out.
//
// Verifies:
//   • every temp password matches the stored bcrypt hash        (X/X PASS)
//   • must_change_password=1, failed_login_count=0, locked_until=NULL for each
//   • email uniqueness, all accounts active, roles + departments intact
//   • 0 candidates, 0 recruitment requests, no demo users reintroduced
//   • the System Admin was not rotated (not present in the map)
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { ensureSchema } from '../src/lib/schema.js';
import { get } from '../src/lib/db.js';
import { loadRoster, integrityChecks, HANDOVER_DIR, ADMIN_EMAIL } from './handover-lib.mjs';

dotenv.config();
ensureSchema();

// ---- locate the credentials map ---------------------------------------
let mapPath = process.argv[2];
if (!mapPath) {
  const cands = fs.existsSync(HANDOVER_DIR)
    ? fs.readdirSync(HANDOVER_DIR).filter((f) => /^credentials-map-.*\.json$/.test(f)).sort()
    : [];
  if (!cands.length) { console.error(`No credentials-map-*.json in ${HANDOVER_DIR}. Pass the path explicitly.`); process.exit(2); }
  mapPath = path.join(HANDOVER_DIR, cands[cands.length - 1]);
}
console.log(`Verifying against: ${mapPath}\n`);
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const accounts = map.accounts || [];
if (!accounts.length) { console.error('credential map has no accounts'); process.exit(2); }

let fail = 0;

// ---- 1. credential verification -------------------------------------
let pass = 0;
const bad = [];
for (const a of accounts) {
  const row = get('SELECT email, password_hash, must_change_password, failed_login_count, locked_until, status FROM users WHERE id=?', [a.id]);
  if (!row) { bad.push(`${a.email}: no such user id ${a.id}`); continue; }
  const hashOk = row.password_hash && bcrypt.compareSync(a.password, row.password_hash);
  const flagsOk = Number(row.must_change_password) === 1
    && Number(row.failed_login_count) === 0
    && (row.locked_until === null || row.locked_until === undefined);
  const activeOk = row.status === 'active';
  if (hashOk && flagsOk && activeOk) pass++;
  else bad.push(`${a.email}: hash=${hashOk} flags=${flagsOk} active=${activeOk}`);
}
console.log(`credential verification: ${pass}/${accounts.length} ${bad.length ? 'FAIL' : 'PASS'}`);
if (bad.length) { console.error('  ' + bad.join('\n  ')); fail++; }

// ---- 2. admin not in the map + still works as a bcrypt account -----
const adminInMap = accounts.some((a) => String(a.email).toLowerCase() === ADMIN_EMAIL);
console.log(`\nsystem admin excluded from rotation: ${adminInMap ? 'FAIL (present in map!)' : 'PASS'}`);
if (adminInMap) fail++;
const adminRow = get('SELECT password_hash FROM users WHERE lower(email)=?', [ADMIN_EMAIL]);
const adminOk = adminRow && /^\$2[aby]\$/.test(adminRow.password_hash || '');
console.log(`system admin account intact (bcrypt hash present): ${adminOk ? 'PASS' : 'FAIL'}`);
if (!adminOk) fail++;

// ---- 3. full integrity pass ---------------------------------------
console.log('\n=== DATA INTEGRITY ===');
const roster = loadRoster();
for (const c of integrityChecks(roster)) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? '  (' + c.detail + ')' : ''}`);
  if (!c.ok) fail++;
}

// ---- 4. every rotated user is forced to change ------------------
const stillDefault = roster.filter((u) => !u.isAdmin && u.status === 'active' && !u.mustChangePassword);
console.log(`\nnon-admin active users still NOT flagged must-change: ${stillDefault.length === 0 ? 'PASS (0)' : 'FAIL — ' + stillDefault.map((u) => u.email).join(', ')}`);
if (stillDefault.length) fail++;

console.log(`\n${fail === 0 ? 'VERIFY OK — safe to distribute the confidential handover.' : `VERIFY FAILED — ${fail} problem(s). Do NOT distribute.`}`);
process.exit(fail === 0 ? 0 : 1);
