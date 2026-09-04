// ============================================================================
// handover-01-audit.mjs  —  READ-ONLY reconciliation of the live users table.
//
//   Run on the server, against the production DATABASE_URL:
//     node prisma/handover-01-audit.mjs
//
// Writes nothing to the database. Prints a reconciliation table + category
// breakdown + data-integrity checks, and (if it can) drops a JSON copy in
// $HANDOVER_DIR (default /var/lib/arabtec-ats/handover, chmod 600).
//
// No passwords are printed. Exit code 1 if any integrity check fails.
// ============================================================================
import dotenv from 'dotenv';
import { ensureSchema } from '../src/lib/schema.js';
import { loadRoster, integrityChecks, categoryFor, writePrivate, stamp } from './handover-lib.mjs';

dotenv.config();
ensureSchema();

const roster = loadRoster();

// ---- reconciliation table ---------------------------------------------------
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log('\n=== USER RECONCILIATION (live database) ===\n');
console.log([
  pad('Emp #', 9), pad('Full name', 34), pad('Email', 34), pad('Job title', 26),
  pad('Department', 20), pad('ATS role', 20), pad('Status', 8), 'MCP FLC Locked  Hash',
].join(' '));
console.log('-'.repeat(190));
for (const u of roster) {
  console.log([
    pad(u.employeeNo, 9), pad(u.fullName, 34), pad(u.email, 34), pad(u.jobTitle, 26),
    pad(u.department, 20), pad(u.roleLabel, 20), pad(u.status, 8),
    pad(u.mustChangePassword ? '1' : '0', 3), pad(u.failedLoginCount, 3),
    pad(u.lockedUntil ? 'YES' : '-', 7), u.hashType,
  ].join(' '));
}

// ---- category breakdown ---------------------------------------------------
const CATS = [
  'System Admin',
  'Recruitment / HR',
  'Hiring Managers / Department Heads / Project Managers',
  'Other active users',
];
console.log('\n=== CATEGORY BREAKDOWN ===\n');
for (const c of CATS) {
  const members = roster.filter((u) => u.category === c);
  console.log(`${c}: ${members.length}`);
  for (const u of members) console.log(`   - ${u.fullName} <${u.email}>  [${u.roleLabel}]  ${u.jobTitle}${u.department ? ' — ' + u.department : ''}`);
  console.log('');
}

const humans = roster.length;
const nonAdmin = roster.filter((u) => !u.isAdmin);
const needRotation = nonAdmin.filter((u) => u.status === 'active');
console.log(`Actual human accounts        : ${humans}`);
console.log(`System Admin (unchanged)     : ${roster.filter((u) => u.isAdmin).length}`);
console.log(`Accounts to receive unique   : ${needRotation.length}`);
console.log(`  temporary credentials`);
console.log(`Already flagged must-change  : ${nonAdmin.filter((u) => u.mustChangePassword).length}/${nonAdmin.length}`);
console.log(`Currently locked             : ${roster.filter((u) => u.lockedUntil).length}`);

// ---- integrity checks -----------------------------------------------------
console.log('\n=== DATA INTEGRITY ===\n');
const checks = integrityChecks(roster);
let failed = 0;
for (const c of checks) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? '  (' + c.detail + ')' : ''}`);
  if (!c.ok) failed++;
}

// ---- optional JSON artefact (never contains a password) -----------------
try {
  const file = writePrivate(`audit-${stamp()}.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totals: {
      humans, systemAdmins: roster.filter((u) => u.isAdmin).length,
      toRotate: needRotation.length, locked: roster.filter((u) => u.lockedUntil).length,
    },
    categories: CATS.map((c) => ({
      category: c,
      users: roster.filter((u) => u.category === c).map((u) => ({
        employeeNo: u.employeeNo, fullName: u.fullName, email: u.email,
        jobTitle: u.jobTitle, department: u.department, roles: u.roles,
        status: u.status, mustChangePassword: u.mustChangePassword,
        failedLoginCount: u.failedLoginCount, locked: !!u.lockedUntil, hashType: u.hashType,
      })),
    })),
    integrity: checks,
  }, null, 2));
  console.log(`\nWrote ${file}`);
} catch (e) {
  console.log(`\n(could not write JSON artefact: ${e.message} — table above is the record)`);
}

console.log(`\n${failed === 0 ? 'AUDIT OK' : `AUDIT: ${failed} integrity check(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
