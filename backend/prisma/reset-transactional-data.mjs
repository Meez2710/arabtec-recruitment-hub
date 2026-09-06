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
 * ORDER IS THE WHOLE DESIGN HERE.
 *
 * Everything reversible happens BEFORE the irreversible database wipe:
 *   1. work out which optional tables exist   (a missing one must not abort a
 *      PostgreSQL transaction half way through)
 *   2. collect the files owned by the doomed rows
 *   3. actually DRAIN THE INBOX
 *   4. only then delete anything from the database
 *   5. then remove the file bytes
 *
 * Step 3 used to run last, and its preflight only checked that the destination
 * could be created — not that the source could be written (rename must unlink
 * the original) and not that the two are on the same filesystem (rename cannot
 * cross devices). So on a read-only share, or an archive path on another mount,
 * the move failed AFTER the candidates were gone and their de-duplication rows
 * with them, and the failure was swallowed. Draining first makes a failure
 * recoverable: nothing has been deleted, and the operator can just move the
 * files back.
 */
function existingTables(candidates) {
  return candidates.filter((t) => count(t) !== null);
}

/** Move the inbox aside. Returns { moved, target } or throws with a clear reason. */
function drainInbox() {
  const inbox = process.env.CV_INBOX;
  if (!inbox) return { skipped: 'CV_INBOX is not set in this environment' };
  if (!fs.existsSync(inbox)) return { skipped: `CV_INBOX does not exist (${inbox})` };
  const files = fs.readdirSync(inbox).filter((f) => /\.(pdf|docx?|txt)$/i.test(f));
  if (!files.length) return { moved: 0, target: null, inbox };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const override = process.env.ARABTEC_RESET_INBOX_ARCHIVE;
  const target = override ? path.join(override, `pre-golive-${stamp}`)
    : path.join(inbox, `.pre-golive-${stamp}`);
  fs.mkdirSync(target, { recursive: true });

  // rename() where possible; copy+unlink when the archive is on another
  // filesystem (EXDEV). Either way the source entry must be removable, which is
  // exactly what a read-only share forbids — and we find that out HERE, before
  // anything has been deleted.
  let moved = 0;
  for (const f of files) {
    const from = path.join(inbox, f);
    const to = path.join(target, f);
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') throw new Error(`cannot move ${f} out of CV_INBOX: ${e.message}`);
      fs.copyFileSync(from, to);
      try { fs.unlinkSync(from); }
      catch (e2) { throw new Error(`copied ${f} to the archive but could not remove the original: ${e2.message}`); }
    }
    moved += 1;
  }
  return { moved, target, inbox };
}

/**
 * CV bytes in the blob store that no row points at.
 *
 * upload.js persists a file the moment it is received, BEFORE the route decides
 * whether to keep it — so a parse that abstained, or a request rejected for a
 * missing candidate name, leaves a real CV in file_blob and UPLOAD_DIR with
 * nothing referencing it. Hand-testing produces plenty of these and the
 * row-based purge cannot see them.
 *
 * Restricted to CV extensions on purpose: branding logos and other company
 * assets live in the same table, are also unreferenced by these five columns,
 * and must survive.
 */
function orphanCvBlobs(alreadyDoomed) {
  const doomed = new Set(alreadyDoomed);
  const referenced = new Set();
  const collect = (sql) => {
    try { for (const r of all(sql)) { if (r.n) referenced.add(r.n); } } catch { /* not in this schema */ }
  };
  collect('SELECT stored_path AS n FROM candidate_document WHERE stored_path IS NOT NULL');
  collect('SELECT stored_name AS n FROM candidate_intake WHERE stored_name IS NOT NULL');
  collect('SELECT resume_path AS n FROM candidate WHERE resume_path IS NOT NULL');
  collect('SELECT attachment_path AS n FROM recruitment_request WHERE attachment_path IS NOT NULL');
  collect('SELECT file_path AS n FROM ticket_post WHERE file_path IS NOT NULL');
  try {
    return all('SELECT stored_name AS n, original_name AS o FROM file_blob')
      .filter((r) => r.n && !referenced.has(r.n) && !doomed.has(r.n))
      .filter((r) => /\.(pdf|docx?)$/i.test(String(r.o || r.n)))
      .map((r) => r.n);
  } catch { return []; }
}

const doomedFiles = storedNamesToPurge();
if (doomedFiles.length) info(`${doomedFiles.length} stored file(s) belong to the rows being cleared`);

const PIPELINE_TABLES = existingTables([
  'application_final_decision', 'application_assessment', 'application_stage_history',
  'interview_feedback', 'interview_panel', 'interview_activity', 'interview',
  'offer_approval', 'offer_activity', 'offer',
  'candidate_note', 'candidate_activity', 'candidate_document',
  'candidate_proposal', 'candidate_intake',
  'application', 'candidate',
  'ticket_post', 'request_activity', 'request_approval', 'requisition_seat', 'recruitment_request',
]);

if (DRY) {
  for (const t of PIPELINE_TABLES) wipe(t);
  wipe('custom_field_value', "entity IN ('request','candidate','application')");
  wipe('notification');
  const cur = all("SELECT key, value FROM system_setting WHERE key LIKE '%_counter'")
    .filter((r) => r.value !== '0').map((r) => `${r.key}=${r.value}`);
  if (cur.length) info(`would reset counters: ${cur.join(', ')}`);
  if (doomedFiles.length) info(`would delete ${doomedFiles.length} file_blob row(s) and their UPLOAD_DIR copies`);
  const orphanPreview = orphanCvBlobs(doomedFiles);
  if (orphanPreview.length) info(`would also delete ${orphanPreview.length} orphaned CV blob(s) with no owning row`);
  const inboxNow = process.env.CV_INBOX && fs.existsSync(process.env.CV_INBOX)
    ? fs.readdirSync(process.env.CV_INBOX).filter((f) => /\.(pdf|docx?|txt)$/i.test(f)).length : 0;
  if (inboxNow) info(`would archive ${inboxNow} file(s) out of CV_INBOX`);
} else {
  // ---- 3. drain the inbox FIRST, while a failure is still recoverable ----
  let drained;
  try {
    drained = drainInbox();
  } catch (e) {
    // An explicit, informed override. Not a default: the operator is stating
    // they have dealt with the folder themselves and accept the consequence.
    if (String(process.env.ARABTEC_RESET_INBOX_ACKNOWLEDGED || '').toLowerCase() === 'true') {
      console.error(`  ! CV_INBOX could not be drained (${e.message}) — continuing because `
        + 'ARABTEC_RESET_INBOX_ACKNOWLEDGED=true. Anything left there WILL be re-imported.');
      drained = { skipped: 'drain acknowledged as handled by the operator' };
    } else {
    console.error([
      '', 'REFUSING TO CONTINUE — the CV inbox could not be drained.', '',
      `  ${e.message}`, '',
      'Nothing has been deleted. Those files must be moved out BEFORE the database',
      'is cleared: the scanner de-duplicates on document hashes and candidate',
      'emails, and this reset deletes both, so anything left behind is re-imported',
      'as a new candidate on the next scan.', '',
      'If the share is READ-ONLY there is no way for this script to clear it —',
      'removing a file needs write access on the directory itself, whatever the',
      'archive path. Someone with write access must empty it, e.g. from the',
      'Windows side of the share.',
      '',
      'ARABTEC_RESET_INBOX_ARCHIVE only relocates the archive (useful to keep the',
      'inbox tidy, or when the archive belongs on another mount); it cannot make',
      'a read-only source removable.',
      '',
      'If those files have ALREADY been processed and you accept that any left',
      'behind will be re-imported, proceed deliberately:',
      '  ARABTEC_RESET_INBOX_ACKNOWLEDGED=true ARABTEC_RESET_CONFIRM=RESET \\',
      '    node --experimental-sqlite prisma/reset-transactional-data.mjs', '',
    ].join('\n'));
    process.exit(1);
    }
  }
  if (drained.skipped) info(`${drained.skipped} — check the CV folder by hand before go-live`);
  else if (drained.moved) ok(`${drained.moved} file(s) moved out of CV_INBOX into ${drained.target}`);
  else info('CV_INBOX is empty — nothing to archive');

  // ---- 4. the database, in ONE transaction ----
  const orphans = orphanCvBlobs(doomedFiles);
  tx(() => {
    for (const t of PIPELINE_TABLES) wipe(t);
    wipe('custom_field_value', "entity IN ('request','candidate','application')");
    wipe('notification');
    for (const k of ['request_counter', 'candidate_counter', 'application_counter',
      'interview_counter', 'offer_counter']) {
      run('UPDATE system_setting SET value = ? WHERE key = ?', ['0', k]);
    }
    for (const name of [...doomedFiles, ...orphans]) {
      try { run('DELETE FROM file_blob WHERE stored_name=?', [name]); } catch { /* older schema */ }
    }
  });
  ok('business-number counters reset to 0');
  if (doomedFiles.length) ok(`${doomedFiles.length} stored file(s) removed from the durable blob store`);
  if (orphans.length) ok(`${orphans.length} orphaned CV blob(s) removed (uploaded, never attached to a row)`);

  // ---- 5. the disk copies. A failure here BREAKS the privacy guarantee, so it
  //         is reported and fails the command rather than being swallowed. ----
  const dir = process.env.UPLOAD_DIR
    || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data/uploads');
  const undeletable = [];
  for (const name of [...doomedFiles, ...orphans]) {
    try { fs.rmSync(path.join(dir, name), { force: true }); }
    catch (e) { undeletable.push(`${name}: ${e.message}`); }
  }
  if (undeletable.length) {
    console.error(`\nRESET INCOMPLETE — ${undeletable.length} cached CV file(s) could not be removed from ${dir}:`);
    for (const u of undeletable.slice(0, 10)) console.error(`  ${u}`);
    console.error('The database rows are gone but these bytes remain on disk and will be picked up by');
    console.error('backup.sh. Fix the permissions and delete them before handover.\n');
    process.exit(1);
  }
  ok(`cached copies removed from ${dir}`);
}

console.log('');
console.log('AFTER: ', snapshot());

if (DRY) {
  console.log('\nDry run — nothing was deleted.\n');
  process.exit(0);
}

// Prove the postcondition rather than asserting it — and say plainly what a
// non-zero count means, because the likeliest cause is not a failed delete.
//
// This transaction isolates only THIS connection. The app service and
// arabtec-cv-scan.timer are separate processes that can commit a candidate,
// intake or request while the reset runs, or between the wipe and this check.
// Nothing here can prevent that, so the runbook requires them to be stopped
// first and this check is what catches it when they were not.
const remaining = HEADLINE.map((t) => [t, count(t)]).filter(([, n]) => n !== null && n > 0);
if (remaining.length) {
  console.error([
    '',
    `RESET INCOMPLETE — still present: ${remaining.map(([t, n]) => `${t}=${n}`).join(', ')}`,
    '',
    'The most likely cause is a WRITER that was still running: the ATS service,',
    'or arabtec-cv-scan.timer firing mid-reset. Stop both, then run this again:',
    '',
    '  sudo systemctl stop arabtec-cv-scan.timer arabtec-m365-sync.timer',
    '  sudo systemctl stop arabtec-ats',
    '  ...run the reset...',
    '  sudo systemctl start arabtec-ats',
    '  sudo systemctl start arabtec-cv-scan.timer arabtec-m365-sync.timer',
    '',
  ].join('\n'));
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
