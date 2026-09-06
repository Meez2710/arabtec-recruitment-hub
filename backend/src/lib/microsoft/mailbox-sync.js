// The delegated mailbox scan: career@arabtecegy.com -> the EXISTING CV intake.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not create candidates. An email
// arriving is not a decision to add someone to the talent pool, and the ATS
// already has a reviewed path for that: parse the CV, propose fields with
// evidence, and let a person approve. Attachments land as PENDING
// `candidate_intake` rows through the very same seam POST /candidates/parse-cv
// uses (parseDocument + createIntake), so mailbox CVs and uploaded CVs are the
// same record, reviewed on the same screen, with the same audit trail.
//
// It replaces deploy/on-prem/mailbox/cv-mailbox-sync.mjs, which wrote files into
// a folder for the watcher to pick up and which used client-credentials auth.
// Both of those are gone here: delegated tokens, and a direct call into the
// intake service rather than a file drop and an HTTP call back into ourselves.

import path from 'node:path';
import crypto from 'node:crypto';

import { storeFile, uploadPath, MAX_BYTES } from '../upload.js';
import { parseDocument } from '../parsing/pipeline-provider.js';
import { createIntake } from '../intake-store.js';
import { writeAudit } from '../audit.js';
import fs from 'node:fs';
import { get, run as dbRun } from '../db.js';
import { CV_EXTENSIONS, configuredMailbox, overlapMinutes, syncBatchSize } from './config.js';
import { acquireGraphToken, classify, CODES, MicrosoftAuthError } from './msal-client.js';
import { listInboxMessages, listAttachments, downloadAttachment } from './graph.js';
import {
  claimAttachment, completeAttachment, releaseAttachment, connectionRow,
  markAttempt, markError, markReconnectRequired, markSyncSuccess, STATUS,
  acquireSyncLease, releaseSyncLease, renewSyncLease,
} from './connection-store.js';

const FILE_ATTACHMENT = '#microsoft.graph.fileAttachment';

/** One scan at a time, in this process. */
let running = false;
export const isSyncRunning = () => running;

const log = (fields) => console.log(JSON.stringify({ level: 'info', ...fields }));
const warn = (fields) => console.log(JSON.stringify({ level: 'warn', ...fields }));

/**
 * Where this scan starts reading.
 *
 * FIRST CONNECTION READS NOTHING HISTORIC. `baseline_at` is stamped when the
 * administrator connects, and with no successful sync yet the window opens
 * exactly there — a mailbox with ten years of applications does not become ten
 * years of review queue because someone clicked Connect.
 *
 * Later scans reach back a small overlap before the last success, because
 * "received at" is the server's clock and a message can be indexed a moment
 * after the previous scan read the folder. The overlap is safe precisely
 * because mailbox_ingestion makes re-reading a message a no-op.
 */
export function syncWindowStart(row, { overlapMin = overlapMinutes() } = {}) {
  const baseline = row?.baseline_at ? new Date(row.baseline_at) : null;
  const last = row?.last_successful_sync_at ? new Date(row.last_successful_sync_at) : null;
  if (!last || Number.isNaN(last.getTime())) {
    return (baseline && !Number.isNaN(baseline.getTime()) ? baseline : new Date()).toISOString();
  }
  const withOverlap = new Date(last.getTime() - overlapMin * 60 * 1000);
  // Never reach back past the baseline — that is the historic mailbox.
  if (baseline && !Number.isNaN(baseline.getTime()) && withOverlap < baseline) return baseline.toISOString();
  return withOverlap.toISOString();
}

/** Is this attachment a CV the existing intake flow accepts? */
export function classifyAttachment(attachment) {
  if (attachment?.isInline === true) return { accept: false, reason: 'inline attachment' };
  if (attachment?.['@odata.type'] !== FILE_ATTACHMENT) return { accept: false, reason: 'not a file attachment' };
  const name = String(attachment?.name || '');
  const ext = path.extname(name).toLowerCase();
  if (!CV_EXTENSIONS.includes(ext)) return { accept: false, reason: `unsupported file type ${ext || '(none)'}` };
  // The app's own 20 MB cap, read from upload.js rather than restated — one
  // limit, defined where uploads are defined.
  if (Number(attachment?.size) > MAX_BYTES) return { accept: false, reason: 'attachment exceeds the 20MB limit' };
  return { accept: true, ext };
}

/**
 * Delete a stored upload that turned out not to be needed.
 *
 * Both copies: the durable file_blob row and the best-effort disk cache. Called
 * only for a file this scan created moments ago and is abandoning, so there is
 * no risk of removing something another record still points at.
 */
function discardStoredFile(storedName) {
  if (!storedName) return;
  try { dbRun('DELETE FROM file_blob WHERE stored_name=?', [storedName]); } catch { /* older schema */ }
  try { fs.rmSync(uploadPath(storedName), { force: true }); } catch { /* cache copy may not exist */ }
}

/** A PENDING intake for these exact bytes is already waiting for a reviewer. */
function pendingIntakeForHash(hash) {
  try {
    return get("SELECT id FROM candidate_intake WHERE file_hash=? AND status='PENDING' LIMIT 1", [hash]) || null;
  } catch { return null; }
}

/**
 * Run one mailbox scan.
 *
 * NEVER THROWS for a per-message or per-attachment failure. A CV that will not
 * parse, an attachment Graph refuses, an intake that produced no fields — each
 * is recorded against its own ledger row and the batch continues. Only a
 * connection-level failure (no token, throttled, Graph down) ends the pass, and
 * even then it is returned, not thrown, so the caller can report it.
 *
 * `parse` defaults to the production CV reader and exists so the mailbox rules —
 * filtering, idempotency, batch resilience, the baseline window — can be tested
 * without an ANTHROPIC_API_KEY and without a network. It is the same seam
 * lib/parsing/registry.js gives the upload route, scoped to one call site.
 *
 * @param {{ actor?: {id:number, fullName?:string}|null, req?: object|null,
 *           parse?: (filePath: string) => Promise<object> }} options
 */
export async function runMailboxSync({ actor = null, req = null, parse = parseDocument } = {}) {
  if (running) {
    return { ok: false, code: 'already-running', error: 'A mailbox scan is already in progress.' };
  }
  const row = connectionRow();
  if (!row || row.status === STATUS.DISCONNECTED || !row.home_account_id) {
    return { ok: false, code: CODES.NOT_CONNECTED, error: 'Microsoft 365 is not connected.' };
  }

  // The in-process flag above cannot see the OTHER process. On-prem the 08:00
  // timer runs m365-sync.mjs separately from the web API, so a manual scan and
  // the scheduled one could overlap, and the loser would still advance the
  // shared watermark past messages the winner had merely claimed. The lease
  // lives in the database, which is the only thing both processes share.
  // The connection this scan belongs to. If it changes underneath us — a
  // disconnect, or a disconnect and reconnect — this scan's result must not be
  // written onto the connection that replaced it.
  const scanGeneration = Number(row.generation ?? 0);
  const leaseOwner = `${process.pid}@${startedAtLabel()}`;
  const lease = acquireSyncLease(leaseOwner);
  if (!lease.acquired) {
    return {
      ok: false, code: 'already-running',
      error: `A mailbox scan is already in progress (held until ${lease.until ?? 'unknown'}).`,
    };
  }

  running = true;
  const mailbox = row.mailbox || configuredMailbox();
  const startedAt = new Date();
  const since = syncWindowStart(row);
  const summary = {
    mailbox, since, messages: 0, attachments: 0, imported: 0, skipped: 0, failed: 0,
    retryable: 0, intakeIds: [], startedAt: startedAt.toISOString(),
    // receivedDateTime of every message this pass did NOT finish. The watermark
    // may not move past the earliest of them.
    unfinished: [],
  };

  try {
    markAttempt();

    // One token for the whole pass. MSAL renews it silently from the stored
    // refresh token; an interaction-required condition surfaces here, once,
    // rather than on every message.
    const { accessToken } = await acquireGraphToken();
    // Shared for the whole pass: a renewal inside any request updates this, so
    // later requests use the new token instead of each re-discovering the
    // expiry and forcing its own refresh.
    const tokenRef = { value: accessToken };

    const messages = await listInboxMessages({ sinceIso: since, top: syncBatchSize(), tokenRef });
    summary.messages = messages.length;
    // listInboxMessages sets this when it stopped with pages outstanding. The
    // watermark cannot express "I read up to here but not past it", so in that
    // case it must NOT jump to the scan's start time — the next run has to
    // re-open the same window and continue.
    summary.truncated = messages.truncated === true;

    for (const message of messages) {
      // The pass may run for a long time on a big mailbox; keep the
      // cross-process lease alive so the other process never concludes it was
      // abandoned and starts a second scan alongside this one.
      try { renewSyncLease(leaseOwner); } catch { /* the lease still has headroom */ }
      try {
        await ingestMessage({ message, mailbox, tokenRef, actor, req, summary, parse });
      } catch (e) {
        const error = classify(e);
        // A connection-level failure mid-batch stops the pass; anything else is
        // this message's problem and the next message still runs.
        if (error.code === CODES.RECONNECT_REQUIRED || error.code === CODES.GRAPH_THROTTLED
          || error.code === CODES.GRAPH_UNAVAILABLE) throw error;
        summary.failed += 1;
        // Nothing may have been claimed yet — listAttachments() can fail before
        // the first claim exists — so there is no ledger row to find this
        // message by later. Without this the scan reported success, advanced the
        // watermark, and the message and every CV on it were never retried once
        // the overlap window passed.
        summary.unfinished.push(message?.receivedDateTime ?? null);
        warn({ msg: 'microsoft.sync.message_failed', messageId: message?.id ?? null, error: error.message });
      }
    }

    // The watermark is the START of the scan, not its end: a message that
    // arrived while the scan was running must be picked up next time.
    //
    // Unless the page walk was capped. Then the newest message actually
    // PROCESSED is the furthest the watermark may honestly move — anything
    // beyond it was never fetched, and advancing over it would lose those CVs
    // exactly the way dropping @odata.nextLink used to.
    // THE WATERMARK MAY NEVER PASS UNFINISHED WORK. Two things can leave work
    // unfinished: a capped page walk (messages never fetched) and a message this
    // pass could not complete — held by a concurrent scan, failed, or awaiting a
    // parser that is not configured yet. Advancing past either is precisely how
    // a CV disappears for good, so the watermark stops at the earliest of them.
    // AS INSTANTS, not strings. Graph may return receivedDateTime without
    // fractional seconds while toISOString() always has them, and
    // "…00Z" sorts AFTER "…00.500Z" lexicographically while being earlier in
    // time. With MS_SYNC_OVERLAP_MIN=0 — which the config accepts — that
    // reversal let the watermark step over an unfinished message inside the
    // same second, losing its CV for good.
    const ms = (t) => { const n = Date.parse(t); return Number.isNaN(n) ? null : n; };
    const earliestUnfinished = summary.unfinished
      .filter(Boolean).map((t) => [t, ms(t)]).filter(([, n]) => n !== null)
      .sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
    let watermark = summary.truncated
      ? (messages.reduce((newest, m) => {
        const a = ms(m.receivedDateTime); const b = ms(newest);
        return a !== null && (b === null || a > b) ? m.receivedDateTime : newest;
      }, since) || since)
      : startedAt.toISOString();
    if (earliestUnfinished) {
      const u = ms(earliestUnfinished); const w = ms(watermark);
      if (u !== null && (w === null || u < w)) watermark = earliestUnfinished;
    }
    summary.watermark = watermark;
    delete summary.unfinished;   // an internal working set, not a result
    markSyncSuccess(summary, watermark, scanGeneration);
    log({ msg: 'microsoft.sync.complete', ...summary, imported: summary.imported });
    // ALWAYS audited. This used to be gated on `req || actor`, which meant the
    // 08:00 timer — the authoritative ingestion path, and the only one that
    // runs unattended — was the single scan that left no trace, including runs
    // that imported CVs. A scan with no interactive actor is attributed to the
    // scheduler rather than skipped.
    try {
      writeAudit(req ?? { user: actor, headers: {} }, {
        action: 'microsoft.sync', entityType: 'integration', entityId: 'microsoft',
        newValue: {
          imported: summary.imported, skipped: summary.skipped, failed: summary.failed,
          messages: summary.messages, truncated: summary.truncated === true,
          trigger: actor ? 'manual' : 'scheduled',
        },
        comments: actor ? undefined : 'scheduled mailbox scan',
      });
    } catch { /* an audit failure must not lose a completed scan */ }
    return { ok: true, ...summary, finishedAt: new Date().toISOString() };
  } catch (e) {
    const error = e instanceof MicrosoftAuthError ? e : classify(e);
    if (error.code === CODES.RECONNECT_REQUIRED || error.code === CODES.TOKEN_CACHE_MISSING) {
      markReconnectRequired(error.message);
    } else {
      markError(error.message, scanGeneration);
    }
    warn({ msg: 'microsoft.sync.failed', code: error.code, error: error.message });
    return { ok: false, code: error.code, error: error.message, ...summary };
  } finally {
    running = false;
    try { releaseSyncLease(leaseOwner); } catch { /* the lease expires on its own */ }
  }
}

/** Stable-ish label for the lease owner; the clock is only used for display. */
function startedAtLabel() { return new Date().toISOString(); }

async function ingestMessage({ message, mailbox, tokenRef, actor, req, summary, parse }) {
  const attachments = await listAttachments(message.id, { tokenRef });
  // A capped attachment walk means CVs on later pages were never seen. The
  // message is NOT complete, so the watermark must not move past it.
  if (attachments.truncated === true) summary.unfinished.push(message.receivedDateTime ?? null);
  const messageKey = message.internetMessageId || message.id;

  for (const attachment of attachments) {
    summary.attachments += 1;
    const verdict = classifyAttachment(attachment);
    const claim = claimAttachment({
      mailbox,
      messageKey,
      attachmentKey: `${attachment.id ?? ''}|${attachment.name ?? ''}`,
      messageId: message.id,
      internetMessageId: message.internetMessageId ?? null,
      attachmentId: attachment.id ?? null,
      attachmentName: attachment.name ?? null,
      receivedAt: message.receivedDateTime ?? null,
    });

    // Seen before — by an earlier scan, by the overlap window, or by a restart.
    if (!claim.claimed) {
      // 'in-progress' means ANOTHER scan holds it right now. It is not done, so
      // this scan must not let the watermark move past it.
      if (claim.reason === 'in-progress') summary.unfinished.push(message.receivedDateTime ?? null);
      summary.skipped += 1;
      continue;
    }

    if (!verdict.accept) {
      completeAttachment(claim.key, { status: 'SKIPPED', reason: verdict.reason });
      summary.skipped += 1;
      continue;
    }

    try {
      const bytes = await downloadAttachment(message.id, attachment.id, { tokenRef });
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');

      const alreadyPending = pendingIntakeForHash(hash);
      if (alreadyPending) {
        completeAttachment(claim.key, {
          status: 'SKIPPED', reason: `an identical CV is already awaiting review (intake ${alreadyPending.id})`,
          intakeId: alreadyPending.id, contentHash: hash,
        });
        summary.skipped += 1;
        continue;
      }

      // The SAME durable store an uploaded CV lands in, so the reviewer opens
      // the original document from the same place.
      const stored = storeFile(attachment.name, bytes);
      const parsed = await parse(uploadPath(stored.storedName));

      if (!parsed.ok || parsed.fields.length === 0) {
        // RETRYABLE vs FINAL, and the difference decides whether this CV is ever
        // seen again. With no ANTHROPIC_API_KEY — a configuration startup
        // explicitly allows — parseDocument returns { ok:false, permanent:false },
        // and so do transient OCR/parser faults. Recording those as SKIPPED
        // marked them permanently handled, so wiring the reader up later could
        // never recover them. Release the claim instead and hold the watermark,
        // so the next scan genuinely retries.
        // `permanent !== true`, not `=== false`. parseDocument omits the field
        // entirely when it cannot READ the file from storage — which happens if
        // storeFile's best-effort disk cache write failed while the durable
        // blob was written fine. The strict check treated that as permanent and
        // de-duplicated the attachment forever, despite its bytes existing.
        // Only an explicit permanent:true may close an attachment.
        if (parsed.permanent !== true) {
          // storeFile() already wrote a durable file_blob row AND a disk copy
          // under a fresh random name. Releasing the claim alone meant every
          // daily retry stored ANOTHER full copy of the same CV — unbounded, and
          // guaranteed in the supported no-reader configuration. Discard this
          // copy; the next attempt re-downloads from Graph, which is the only
          // source of truth anyway.
          discardStoredFile(stored.storedName);
          releaseAttachment(claim.key);
          summary.retryable += 1;
          summary.unfinished.push(message.receivedDateTime ?? null);
          warn({
            msg: 'microsoft.sync.parse_retryable', attachment: attachment.name ?? null,
            reason: parsed.reason || 'the CV reader is not available',
          });
          continue;
        }
        completeAttachment(claim.key, {
          status: 'SKIPPED',
          reason: parsed.reason || 'No candidate field could be supported by the document.',
          storedName: stored.storedName, contentHash: hash,
        });
        summary.skipped += 1;
        continue;
      }

      const intake = createIntake({
        storedName: stored.storedName,
        fileName: attachment.name,
        mimeType: attachment.contentType || null,
        fileHash: hash,
        origin: 'mailbox.microsoft',
        modelId: parsed.generation?.modelId ?? '',
        documentId: parsed.documentId,
        generation: parsed.generation,
        fields: parsed.fields,
        // No requisition: nothing in an email says which vacancy this is for.
        // A reviewer links it, exactly as they do for an uploaded CV.
        createdBy: actor?.id ?? null,
      });

      if (!intake) {
        completeAttachment(claim.key, {
          status: 'SKIPPED', reason: 'The parse produced no reviewable field.',
          storedName: stored.storedName, contentHash: hash,
        });
        summary.skipped += 1;
        continue;
      }

      completeAttachment(claim.key, {
        status: 'IMPORTED', intakeId: intake.id, storedName: stored.storedName, contentHash: hash,
      });
      summary.imported += 1;
      summary.intakeIds.push(intake.id);

      try {
        writeAudit(req ?? { user: actor, headers: {} }, {
          action: 'candidate.intake_created', entityType: 'candidate_intake', entityId: intake.id,
          newValue: {
            fileName: attachment.name, fields: intake.fields.length,
            source: 'microsoft-mailbox', mailbox,
          },
        });
      } catch { /* an audit failure must not lose the intake */ }
    } catch (e) {
      const error = classify(e);
      if (error.code === CODES.RECONNECT_REQUIRED || error.code === CODES.GRAPH_THROTTLED
        || error.code === CODES.GRAPH_UNAVAILABLE) {
        // Not this attachment's fault — let the next scan have it.
        releaseAttachment(claim.key);
        throw error;
      }
      completeAttachment(claim.key, { status: 'FAILED', reason: error.message });
      summary.failed += 1;
      summary.unfinished.push(message.receivedDateTime ?? null);
      warn({ msg: 'microsoft.sync.attachment_failed', attachment: attachment.name ?? null, error: error.message });
    }
  }
}
