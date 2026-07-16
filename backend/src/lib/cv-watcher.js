// CV Inbox Folder Watcher — periodically scans a folder for new CVs and
// auto-imports them into the talent pool. Configurable via env vars:
//
//   CV_INBOX               — path to the watched folder (default: ../../cv_inbox)
//   CV_WATCH_INTERVAL_MIN  — scan interval in minutes (default: 60, 0 = disabled)
//
// Controlled by the feature flag: feature.folder_watcher

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_INBOX = path.resolve(__dirname, '../../cv_inbox');
const DEFAULT_INTERVAL_MIN = 60; // run every hour by default

let watcherTimer = null;
let lastScanAt = null;
let lastScanResult = null;
let scanCount = 0;

export function getWatcherStatus() {
  const inboxDir = process.env.CV_INBOX || DEFAULT_INBOX;
  const exists = fs.existsSync(inboxDir);
  let fileCount = 0;
  if (exists) {
    try { fileCount = fs.readdirSync(inboxDir).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.pdf', '.docx', '.doc'].includes(ext);
    }).length; } catch {}
  }
  return {
    running: watcherTimer !== null,
    intervalMin: parseInt(process.env.CV_WATCH_INTERVAL_MIN, 10) || DEFAULT_INTERVAL_MIN,
    inboxDir,
    inboxExists: exists,
    pendingFiles: fileCount,
    lastScanAt,
    lastScanResult,
    scanCount,
  };
}

export function startWatcher() {
  if (watcherTimer) return; // already running

  const intervalMin = parseInt(process.env.CV_WATCH_INTERVAL_MIN, 10) || DEFAULT_INTERVAL_MIN;
  if (intervalMin <= 0) return;

  const doScan = async () => {
    const inboxDir = process.env.CV_INBOX || DEFAULT_INBOX;
    if (!fs.existsSync(inboxDir)) return;

    try {
      // Dynamic import to avoid circular dep at module load
      const { parseHeuristic } = await import('./cv-parser.js');
      const { Candidates, CandidateDocuments, CandidateActivity } = await import('./models.js');
      const { writeAudit } = await import('./audit.js');
      const { get, run } = await import('./db.js');

      const files = fs.readdirSync(inboxDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ['.pdf', '.docx', '.doc'].includes(ext);
      });

      let imported = 0, skipped = 0;
      for (const file of files) {
        const filePath = path.join(inboxDir, file);
        try {
          const parsed = await parseHeuristic(filePath);
          if (parsed.extraction_status === 'failed' || !parsed.full_name) {
            skipped++; continue;
          }
          if (parsed.email) {
            const dups = Candidates.findDuplicates({ email: parsed.email });
            if (dups.length) { skipped++; continue; }
          }

          const candidateNo = Candidates.nextNo();
          const created = Candidates.create({
            candidateNo, fullName: parsed.full_name,
            email: parsed.email, phone: parsed.phone,
            yearsExperience: parsed.years_experience,
            source: 'folder_drop',
            ownerRecruiterId: null, createdBy: null,
            resumeName: file, resumePath: filePath,
          });

          CandidateDocuments.add({
            candidateId: created.id, docType: 'cv', fileName: file,
            fileHash: null, uploadedBy: null,
          });

          CandidateActivity.add({
            candidateId: created.id, actorId: null, actorName: 'watcher',
            type: 'candidate_created',
            note: `${candidateNo} (auto-imported: ${file})`,
          });

          try { writeAudit(null, { action: 'candidate.created', entityType: 'candidate',
            entityId: created.id, newValue: { candidateNo, fullName: created.full_name, source: 'folder_watcher_auto' } }); } catch {}

          imported++;
        } catch { skipped++; }
      }

      lastScanAt = new Date().toISOString();
      lastScanResult = { imported, skipped };
      scanCount++;
      console.log(`[watcher] Scan #${scanCount}: ${imported} imported, ${skipped} skipped`);
    } catch (e) {
      console.error('[watcher] Scan error:', e.message);
    }
  };

  // Run immediately on start, then on interval
  doScan();
  watcherTimer = setInterval(doScan, intervalMin * 60 * 1000);
  watcherTimer.unref?.(); // don't hold the process open
}

export function stopWatcher() {
  if (watcherTimer) { clearInterval(watcherTimer); watcherTimer = null; }
}
