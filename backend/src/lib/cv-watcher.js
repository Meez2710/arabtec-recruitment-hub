// CV inbox folder watcher — polls a folder and imports dropped CVs.
//
// SCHEDULING AND IMPORT ONLY. This file used to contain a second, complete
// parsing system: its own pdf/docx text extraction, its own Ollama call, its own
// DeepSeek call, and its own heuristic parser. That made the watcher a parallel
// production path whose results nobody compared against the upload path — two
// implementations, two sets of failures, one candidate table.
//
// It now calls the SAME parser the HTTP routes call, through the same registry.
// Whatever reads a CV uploaded through the UI reads a CV dropped in the folder.
//
// One behaviour is deliberately gone with it: the old heuristic derived a
// candidate's name from the FILENAME and fell back to the literal string
// "Unknown", creating candidates whose name appeared in no document. The new
// parser abstains instead, and the file is skipped with a reason.
//
// Config via env vars:
//   CV_INBOX               — watched folder (default: ../../cv_inbox)
//   CV_WATCH_INTERVAL_MIN  — poll interval in minutes (default: 60, 0 = disabled)
//
// Parser selection is not configured here — see lib/parsing/composition.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getParser } from './parsing/registry.js';
import { toCandidatePayload } from './cv-mapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_INBOX = path.resolve(__dirname, '../../cv_inbox');
const DEFAULT_INTERVAL_MIN = 60;
const WATCHED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt'];

let watcherTimer = null;
let lastScanAt = null;
let lastScanResult = null;
let scanCount = 0;

const isWatched = (file) => WATCHED_EXTENSIONS.includes(path.extname(file).toLowerCase());

export function getWatcherStatus() {
  const inboxDir = process.env.CV_INBOX || DEFAULT_INBOX;
  const exists = fs.existsSync(inboxDir);
  let fileCount = 0;
  if (exists) {
    try {
      fileCount = fs.readdirSync(inboxDir).filter(isWatched).length;
    } catch { /* an unreadable inbox reports zero, not a crash */ }
  }
  let engine = 'unconfigured';
  try { engine = getParser().name; } catch { /* registry not configured yet */ }
  return {
    running: watcherTimer !== null,
    engine,
    intervalMin: parseInt(process.env.CV_WATCH_INTERVAL_MIN, 10) || DEFAULT_INTERVAL_MIN,
    inboxDir,
    inboxExists: exists,
    pendingFiles: fileCount,
    lastScanAt,
    lastScanResult,
    scanCount,
  };
}

/**
 * Import one file. Returns why it was skipped, or the candidate it created.
 *
 * Only values the parser marked persistable are written, exactly as the upload
 * route does — the watcher has no privileged path into the candidate table.
 */
async function importFile(filePath, file, models) {
  const { Candidates, CandidateDocuments, CandidateActivity } = models;

  const entities = await getParser().parseEntities(filePath);
  const { payload } = toCandidatePayload(entities);

  if (entities.metadata.parse_status === 'failed' || !payload.fullName) {
    return {
      skipped: true,
      reason: entities.metadata.parse_status_reason
        || 'no candidate name was supported by the document',
    };
  }

  if (payload.email) {
    const duplicates = Candidates.findDuplicates({ email: payload.email });
    if (duplicates.length) {
      return { skipped: true, reason: `duplicate email (${duplicates[0].candidate_no})` };
    }
  }

  const candidateNo = Candidates.nextNo();
  const created = Candidates.create({
    candidateNo,
    ...payload,
    source: 'folder_drop',
    ownerRecruiterId: null,
    createdBy: null,
    resumeName: file,
    resumePath: filePath,
  });

  CandidateDocuments.add({
    candidateId: created.id, docType: 'cv', fileName: file, fileHash: null, uploadedBy: null,
  });
  CandidateActivity.add({
    candidateId: created.id, actorId: null, actorName: 'watcher',
    type: 'candidate_created', note: `${candidateNo} (folder_drop: ${file})`,
  });

  return { skipped: false, created, candidateNo };
}

export function startWatcher() {
  if (watcherTimer) return;
  const intervalMin = parseInt(process.env.CV_WATCH_INTERVAL_MIN, 10) || DEFAULT_INTERVAL_MIN;
  if (intervalMin <= 0) return;

  const doScan = async () => {
    const inboxDir = process.env.CV_INBOX || DEFAULT_INBOX;
    if (!fs.existsSync(inboxDir)) return;

    try {
      const models = await import('./models.js');
      const { writeAudit } = await import('./audit.js');

      const files = fs.readdirSync(inboxDir).filter(isWatched);
      let imported = 0;
      let skipped = 0;

      for (const file of files) {
        const filePath = path.join(inboxDir, file);
        try {
          const result = await importFile(filePath, file, models);
          if (result.skipped) { skipped += 1; continue; }
          try {
            writeAudit(null, {
              action: 'candidate.created',
              entityType: 'candidate',
              entityId: result.created.id,
              newValue: {
                candidateNo: result.candidateNo,
                fullName: result.created.full_name,
                engine: getParser().name,
              },
            });
          } catch { /* an audit failure must not lose the import */ }
          imported += 1;
        } catch (error) {
          skipped += 1;
          // Loud, and without CV content: a silent skip is how a whole inbox
          // quietly fails to import.
          console.error(JSON.stringify({
            level: 'error', msg: 'watcher.file_failed', file,
            error: String((error && error.message) || error),
          }));
        }
      }

      lastScanAt = new Date().toISOString();
      lastScanResult = { imported, skipped };
      scanCount += 1;
      console.log(`[watcher] Scan #${scanCount}: ${imported} imported, ${skipped} skipped`);
    } catch (e) {
      console.error('[watcher] Scan error:', e.message);
    }
  };

  void doScan();
  watcherTimer = setInterval(() => { void doScan(); }, intervalMin * 60 * 1000);
  watcherTimer.unref?.();
}

export function stopWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}
