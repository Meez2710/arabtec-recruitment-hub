// ============================================================================
// Production readiness reset — clear the pipeline, keep the company.
//
//   ARABTEC_RESET_CONFIRM=RESET node --experimental-sqlite prisma/reset-transactional-data.mjs
//   ...--dry-run     report what WOULD be deleted, delete nothing
//
// WHAT THIS IS FOR. Before the ATS is handed to recruiters, the database has to
// hold zero candidates and zero hiring requests — whatever was created while
// people were trying the system out has to go — while the real company data it
// was configured with stays exactly as it is.
//
// WHY NOT migrate-arabtec-data.mjs. That script also gets candidates and
// requests to zero, but only as a side effect of wiping and reloading the ORG
// data: departments, projects, the 41 managers-as-users, 459 designations. On a
// box where that data is already loaded and has since been corrected by hand, a
// re-run silently reverts every correction and re-creates the user accounts.
// That is a much bigger blast radius than "clear the pipeline", so this is a
// separate, narrower tool.
//
// WHAT IT DELETES: candidates, applications, interviews, offers, recruitment
// requests and everything hanging off them, plus the pre-candidate intake queue,
// their custom-field values, in-app notifications, and the business-number
// counters (so the client's genuinely-first requisition is REQ-…-00001, not
// 00002 because a trial run got there first).
//
// WHAT IT LEAVES ALONE: users, roles, permissions, sessions, departments,
// projects, sites, designations, business units, branding, buttons, workflows,
// system settings, notification configuration, feature flags, and the audit log
// — the audit log because a production system should be able to show that this
// reset happened, and to whom the box was handed.
// ============================================================================
import dotenv from 'dotenv';
import { get, run, all } from '../src/lib/db.js';

dotenv.config();

const DRY = process.argv.includes('--dry-run');

/* --------------------------- FAIL CLOSED, FIRST ---------------------------
 * Same reasoning as migrate-arabtec-data.mjs: a tool that deletes a live
 * recruitment pipeline must not be one mistyped DATABASE_URL away from running.
 * Checked before anything is read or written, so a refusal changes nothing.
 * ------------------------------------------------------------------------ */
if (!DRY && process.env.ARABTEC_RESET_CONFIRM !== 'RESET') {
  console.error([
    '',
    'REFUSING TO RUN — ARABTEC_RESET_CONFIRM is not set to RESET.',
    '',
    'This deletes every candidate, application, interview, offer and hiring',
    'request in the database DATABASE_URL points at. Company data (users, org,',
    'settings, audit) is left untouched.',
    '',
    '  ARABTEC_RESET_CONFIRM=RESET \\',
    '    node --experimental-sqlite prisma/reset-transactional-data.mjs',
    '',
    'To see what it would delete without deleting anything:',
    '',
    '  node --experimental-sqlite prisma/reset-transactional-data.mjs --dry-run',
    '',
    'Nothing has been changed.',
    '',
  ].join('\n'));
  process.exit(1);
}

const ok = (m) => console.log('  ✓ ' + m);
const info = (m) => console.log('  • ' + m);

function count(table, where = '') {
  try { return get(`SELECT COUNT(*) c FROM ${table}${where ? ' WHERE ' + where : ''}`).c; }
  catch { return null; } // table not in this schema version
}

/**
 * Delete from a table that may not exist in this schema version.
 *
 * Deliberately the same contract migrate-arabtec-data.mjs uses: a missing table
 * is legitimate (an older database predates candidate_intake, a newer one has
 * mailbox_ingestion), but any OTHER failure stops the run rather than being
 * logged and stepped over — a delete that silently does nothing leaves orphans
 * that only surface later as a foreign-key error.
 */
function wipe(table, where = '') {
  if (DRY) {
    const n = count(table, where);
    if (n === null) { info(`skip ${table} (not in this schema)`); return 0; }
    if (n) info(`would delete ${n} from ${table}${where ? ' WHERE ' + where : ''}`);
    return n;
  }
  try {
    return run(`DELETE FROM ${table}${where ? ' WHERE ' + where : ''}`)?.changes ?? 0;
  } catch (e) {
    const msg = e.message.split('\n')[0];
    if (/no such table|does not exist/i.test(msg)) { info(`skip ${table} (not in this schema)`); return 0; }
    throw new Error(`DELETE FROM ${table} failed: ${msg}`);
  }
}

const HEADLINE = ['candidate', 'application', 'recruitment_request', 'interview', 'offer', 'candidate_intake'];
const snapshot = () => HEADLINE.map((t) => `${t}=${count(t) ?? '-'}`).join('  ');

console.log(`\n${DRY ? 'DRY RUN — ' : ''}Arabtec production reset: clear the pipeline, keep the company\n`);
console.log('BEFORE:', snapshot());
console.log('');

// Children before parents throughout — these are real foreign keys.
for (const t of [
  'application_final_decision', 'application_assessment', 'application_stage_history',
  'interview_feedback', 'interview_panel', 'interview_activity', 'interview',
  'offer_approval', 'offer_activity', 'offer',
  'candidate_note', 'candidate_activity', 'candidate_document',
  'candidate_proposal', 'candidate_intake',
  'application', 'candidate',
]) wipe(t);

for (const t of [
  'ticket_post', 'request_activity', 'request_approval', 'requisition_seat', 'recruitment_request',
]) wipe(t);

// Custom-field VALUES for the wiped rows only. The field DEFINITIONS
// (custom_field) are configuration and stay.
wipe('custom_field_value', "entity IN ('request','candidate','application')");

// In-app notifications point at requests and candidates that no longer exist;
// a recruiter's first login should not open onto a bell full of dead links.
wipe('notification');

// Counters. Without this the client's first requisition is REQ-2026-00002
// because a trial run already minted 00001.
if (!DRY) {
  for (const k of ['request_counter', 'candidate_counter', 'application_counter',
    'interview_counter', 'offer_counter']) {
    run('UPDATE system_setting SET value = ? WHERE key = ?', ['0', k]);
  }
  ok('business-number counters reset to 0');
} else {
  const cur = all("SELECT key, value FROM system_setting WHERE key LIKE '%_counter'")
    .filter((r) => r.value !== '0').map((r) => `${r.key}=${r.value}`);
  if (cur.length) info(`would reset counters: ${cur.join(', ')}`);
}

// mailbox_ingestion is deliberately NOT cleared. It is the ledger that stops the
// careers mailbox re-importing mail the ATS has already seen; emptying it would
// make the next scheduled scan re-ingest every message back to the connection
// baseline and refill the review queue this reset just emptied. Clear it by hand
// only if re-importing is the actual intent.
const ledger = count('mailbox_ingestion');
if (ledger !== null) {
  info(`mailbox_ingestion kept (${ledger} rows) — clearing it would re-import that mail on the next scan`);
}

console.log('');
console.log('AFTER: ', snapshot());

if (DRY) {
  console.log('\nDry run — nothing was deleted.\n');
  process.exit(0);
}

// Prove the postcondition rather than asserting it. A reset that reports success
// while leaving rows behind is worse than one that fails.
const remaining = HEADLINE.map((t) => [t, count(t)]).filter(([, n]) => n !== null && n > 0);
if (remaining.length) {
  console.error(`\nRESET INCOMPLETE — still present: ${remaining.map(([t, n]) => `${t}=${n}`).join(', ')}\n`);
  process.exit(1);
}

try {
  run(`INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, comments, occurred_at)
       VALUES (?,?,?,?,?,?,?,?)`,
  [null, 'production reset', 'system', 'system.production_reset', 'system', 'global',
    'Cleared all candidates, applications, interviews, offers and hiring requests; counters reset. Company data untouched.',
    new Date().toISOString()]);
} catch { /* an audit failure must not fail a completed reset */ }

console.log('\n✅ Pipeline cleared. Candidates and hiring requests are at zero; company data untouched.\n');
