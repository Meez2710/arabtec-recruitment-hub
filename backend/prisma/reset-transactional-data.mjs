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
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

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

// Imported only AFTER the guard below. src/lib/db.js opens the database in its
// module body — on SQLite that creates the file and writes a probe table — so a
// static import would mean a REFUSED run still touched the target database.
const { get, run, all, tx } = await import('../src/lib/db.js');

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

/**
 * The stored files belonging to the rows we are about to delete.
 *
 * Deleting candidate_document / candidate_intake / candidate removes only the
 * REFERENCES. upload.js keeps the actual CV bytes in file_blob and a copy under
 * UPLOAD_DIR, so a reset that stops at the rows leaves real people's CVs in the
 * production database, on disk, and in every backup taken afterwards — with no
 * metadata left to find them by. Collect the names FIRST, while the rows that
 * name them still exist, and delete only those: branding logos and requisition
 * attachments live in the same table and must survive.
 */
function storedNamesToPurge() {
  const names = new Set();
  const collect = (sql) => {
    try { for (const r of all(sql)) { if (r.n) names.add(r.n); } } catch { /* table not in this schema */ }
  };
  collect('SELECT stored_path AS n FROM candidate_document WHERE stored_path IS NOT NULL');
  collect('SELECT stored_name AS n FROM candidate_intake WHERE stored_name IS NOT NULL');
  collect('SELECT resume_path AS n FROM candidate WHERE resume_path IS NOT NULL');
  // Requests and ticket threads carry uploads too — a job description on the
  // requisition, a file or CV posted into the thread — and both owning tables
  // are wiped below. Missing them destroyed the only reference while leaving
  // the file itself in file_blob, UPLOAD_DIR and every later backup.
  collect('SELECT attachment_path AS n FROM recruitment_request WHERE attachment_path IS NOT NULL');
  collect('SELECT file_path AS n FROM ticket_post WHERE file_path IS NOT NULL');
  return [...names];
}

/**
 * Can the inbox actually be drained, and is there anything to drain?
 *
 * Resolved BEFORE the transaction on purpose. ats.env.template says the HR share
 * may be mounted read-only, so mkdir can fail — and it used to fail AFTER the
 * commit, leaving the candidates deleted, the files still armed, and the
 * de-duplication records (document hashes, candidate emails) gone, so the next
 * scan would re-import every one of them as brand new. Refusing up front costs
 * nothing; discovering it afterwards is unrecoverable.
 */
function planInboxDrain() {
  const inbox = process.env.CV_INBOX;
  if (!inbox || !fs.existsSync(inbox)) return { files: [], target: null, blocked: false };
  const files = fs.readdirSync(inbox).filter((f) => /\.(pdf|docx?|txt)$/i.test(f));
  if (!files.length) return { files: [], target: null, blocked: false };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const override = process.env.ARABTEC_RESET_INBOX_ARCHIVE;
  const target = override ? path.join(override, `pre-golive-${stamp}`)
    : path.join(inbox, `.pre-golive-${stamp}`);
  try {
    fs.mkdirSync(target, { recursive: true });
    // Prove we can actually MOVE into it, not merely create it: a read-only
    // bind mount can still allow mkdir on the parent in some configurations.
    const probe = path.join(target, '.writable-probe');
    fs.writeFileSync(probe, 'x'); fs.rmSync(probe, { force: true });
    return { files, target, blocked: false, inbox };
  } catch (e) {
    return { files, target, blocked: true, inbox, reason: String(e.message || e) };
  }
}

const drain = DRY ? { files: [], blocked: false } : planInboxDrain();
if (!DRY && drain.blocked) {
  console.error([
    '',
    'REFUSING TO RUN — CV_INBOX holds files but cannot be written to.',
    '',
    `  inbox:  ${drain.inbox}`,
    `  files:  ${drain.files.length}`,
    `  reason: ${drain.reason}`,
    '',
    'Those files must be moved out BEFORE the database is cleared. The scanner',
    'de-duplicates on document hashes and candidate emails, and this reset',
    'deletes both — so leaving them in place means the next scan re-imports',
    'every one of them as a new candidate.',
    '',
    'Either clear the share by hand, or archive somewhere writable:',
    '',
    '  ARABTEC_RESET_INBOX_ARCHIVE=/var/lib/arabtec-ats/cv_inbox_archive \\',
    '    ARABTEC_RESET_CONFIRM=RESET node --experimental-sqlite prisma/reset-transactional-data.mjs',
    '',
    'Nothing has been changed.',
    '',
  ].join('\n'));
  process.exit(1);
}

const doomedFiles = storedNamesToPurge();
if (doomedFiles.length) info(`${doomedFiles.length} stored CV file(s) belong to the rows being cleared`);

const PIPELINE_TABLES = [
  'application_final_decision', 'application_assessment', 'application_stage_history',
  'interview_feedback', 'interview_panel', 'interview_activity', 'interview',
  'offer_approval', 'offer_activity', 'offer',
  'candidate_note', 'candidate_activity', 'candidate_document',
  'candidate_proposal', 'candidate_intake',
  'application', 'candidate',
  'ticket_post', 'request_activity', 'request_approval', 'requisition_seat', 'recruitment_request',
];

if (DRY) {
  for (const t of PIPELINE_TABLES) wipe(t);
  wipe('custom_field_value', "entity IN ('request','candidate','application')");
  wipe('notification');
  const cur = all("SELECT key, value FROM system_setting WHERE key LIKE '%_counter'")
    .filter((r) => r.value !== '0').map((r) => `${r.key}=${r.value}`);
  if (cur.length) info(`would reset counters: ${cur.join(', ')}`);
  if (doomedFiles.length) info(`would delete ${doomedFiles.length} file_blob row(s) and their UPLOAD_DIR copies`);
} else {
  // ONE TRANSACTION. Every delete used to autocommit on its own, so a failure
  // part-way — a foreign-key child this script does not know about, a denied
  // counter update — left the live database irreversibly half-cleared while the
  // command reported an error. tx() requires a synchronous callback; everything
  // in here is synchronous by construction.
  tx(() => {
    for (const t of PIPELINE_TABLES) wipe(t);
    wipe('custom_field_value', "entity IN ('request','candidate','application')");
    wipe('notification');
    for (const k of ['request_counter', 'candidate_counter', 'application_counter',
      'interview_counter', 'offer_counter']) {
      run('UPDATE system_setting SET value = ? WHERE key = ?', ['0', k]);
    }
    // The bytes, in the same transaction as the rows that referenced them.
    for (const name of doomedFiles) {
      try { run('DELETE FROM file_blob WHERE stored_name=?', [name]); } catch { /* older schema */ }
    }
  });
  ok('business-number counters reset to 0');
  if (doomedFiles.length) ok(`${doomedFiles.length} stored CV file(s) removed from the durable blob store`);
}

// The UPLOAD_DIR cache copies, outside the transaction because the filesystem
// cannot join one. Done after the commit so a rolled-back reset never deletes a
// file whose row still exists.
if (!DRY && doomedFiles.length) {
  const dir = process.env.UPLOAD_DIR
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/uploads');
  let removed = 0;
  for (const name of doomedFiles) {
    try { fs.rmSync(path.join(dir, name), { force: true }); removed += 1; } catch { /* already gone */ }
  }
  ok(`${removed} cached copy/copies removed from ${dir}`);
}

// The inbox drain, using the plan resolved BEFORE the transaction — so by the
// time we get here the target directory is known to exist and to be writable.
if (!DRY) {
  if (drain.files.length) {
    let moved = 0;
    for (const f of drain.files) {
      try { fs.renameSync(path.join(drain.inbox, f), path.join(drain.target, f)); moved += 1; }
      catch { /* reported below as a shortfall */ }
    }
    ok(`${moved}/${drain.files.length} file(s) moved out of CV_INBOX into ${drain.target}`);
    if (moved < drain.files.length) {
      console.error(`  ! ${drain.files.length - moved} file(s) could NOT be moved — clear them by hand `
        + 'before the next scan, or they will be re-imported as new candidates.');
    }
  } else if (!process.env.CV_INBOX) {
    info('CV_INBOX is not set in this environment — check the folder by hand before go-live');
  } else {
    info('CV_INBOX is empty — nothing to archive');
  }
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

// db.js starts a referenced worker thread on the PostgreSQL path, so without an
// explicit exit this command prints success and then hangs forever. The dry-run
// and refusal paths already exit; the success path did not, and the SQLite-only
// test could never catch it.
process.exit(0);
