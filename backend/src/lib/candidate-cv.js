// Which stored file is a candidate's CV (production fix, 12 Oct 2026).
//
// A CV uploaded on the profile sets candidate.resume_path. Automatic ingestion
// (cv-intake/auto-ingest.js) keeps the CV instead as the intake's stored file
// plus a candidate_document row carrying the file's SHA-256 — it never set
// resume_path, so those candidates showed "No résumé on file" and every
// View-CV entry point returned 404.
//
// Resolution happens at READ time (no migration, no backfill write), and only
// through explicit, candidate-owned provenance:
//   • an existing resume_path always wins — an ingested file never replaces it;
//   • a CV document row is opened by its ID and must belong to this candidate;
//   • its bytes come only from an intake with the SAME hash that ingestion
//     explicitly linked to THIS candidate (candidate_intake.candidate_id —
//     set on CONVERTED and on DUPLICATE/newer-CV). No hash-only fallback;
//   • the same bytes also linked to a DIFFERENT candidate make the row
//     ambiguous: never served, reported as an exception;
//   • bytes are re-hashed before serving; a mismatch is refused.
// Anything that does not resolve is reported (cvDocumentStatus) for recovery,
// never guessed.
import crypto from 'node:crypto';
import { all, get } from './db.js';
import { readBlob } from './upload.js';

/** Why a CV document row can or cannot be opened. Never touches the disk. */
export function cvDocumentStatus(candidateId, doc) {
  if (!doc || Number(doc.candidate_id) !== Number(candidateId) || doc.doc_type !== 'cv') return { ok: false, problem: 'not_a_cv_of_this_candidate' };
  if (!doc.file_hash) return { ok: false, problem: 'no_hash' };
  const intakes = all(`SELECT id, stored_name, file_name, candidate_id FROM candidate_intake
                        WHERE file_hash = ? AND stored_name IS NOT NULL ORDER BY id DESC`, [doc.file_hash]);
  const mine = intakes.filter((r) => Number(r.candidate_id) === Number(candidateId));
  if (intakes.some((r) => r.candidate_id != null && Number(r.candidate_id) !== Number(candidateId))) return { ok: false, problem: 'ambiguous' };
  if (!mine.length) return { ok: false, problem: 'unlinked' };
  return { ok: true, storedName: mine[0].stored_name, fileName: doc.file_name || mine[0].file_name || null, fileHash: doc.file_hash, intakeId: mine[0].id };
}

/** This candidate's CV document rows, newest first, each with its status. */
export function cvDocuments(candidateId) {
  return all(`SELECT * FROM candidate_document WHERE candidate_id = ? AND doc_type = 'cv' ORDER BY id DESC`, [candidateId])
    .map((d) => ({ doc: d, status: cvDocumentStatus(candidateId, d) }));
}

/** The candidate's current CV: { storedName, fileName, source, docId? } or null. */
export function resolveCandidateCv(c) {
  if (!c) return null;
  if (c.resume_path) return { storedName: c.resume_path, fileName: c.resume_name || null, source: 'profile' };
  const first = cvDocuments(c.id).find((x) => x.status.ok);
  return first ? { ...first.status, source: 'intake', docId: first.doc.id } : null;
}

function verified(ref) {
  const f = readBlob(ref.storedName);
  if (!f) return { status: 404, error: 'The CV file could not be found in storage; ask an administrator to restore it.' };
  if (ref.fileHash && crypto.createHash('sha256').update(f.data).digest('hex') !== ref.fileHash) {
    return { status: 409, error: 'This CV file no longer matches the document recorded for the candidate, so it is not shown. Ask an administrator to check it.' };
  }
  return { ref, file: f };
}

/** The candidate's current CV for serving, or { status, error }. */
export function loadCandidateCv(c) {
  const ref = resolveCandidateCv(c);
  if (!ref) return { status: 404, error: 'No resume on file.' };
  return verified(ref);
}

/** One CV document row's own bytes for serving, or { status, error }. */
export function loadCvDocument(candidateId, docId) {
  const doc = get('SELECT * FROM candidate_document WHERE id = ?', [docId]);
  const st = cvDocumentStatus(candidateId, doc);
  if (!st.ok) {
    const msg = { not_a_cv_of_this_candidate: 'Document not found.', no_hash: 'This document has no recorded fingerprint, so it cannot be opened safely.',
      ambiguous: 'This file is linked to more than one candidate, so it is not shown. It is listed for an administrator to resolve.',
      unlinked: 'The original file for this document is not linked to this candidate, so it is not shown. It is listed for an administrator to resolve.' }[st.problem];
    return { status: st.problem === 'not_a_cv_of_this_candidate' ? 404 : 409, error: msg, problem: st.problem };
  }
  return verified(st);
}
