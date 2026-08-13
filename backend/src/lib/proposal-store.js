// Persistence for the EXISTING `CandidateProposal` aggregate, on the EXISTING
// production database.
//
// A REPOSITORY, NOT A MODEL. Every rule about what a proposal is — which fields
// may be proposed, that a review is all-or-nothing per field, that an unreviewed
// proposal is superseded rather than left to rot, that accepting nothing means
// REJECTED — lives in `modules/talent/domain/proposal.ts` and is not restated
// here. This file only turns that aggregate into rows and back.
//
// WHY IT EXISTS. The aggregate's other repository is Drizzle/Postgres and
// belongs to the API entry point that is not deployed. The deployed server has
// its own SQLite/Postgres layer. Rather than migrate the live `candidate` table
// to suit the other one, this adapts the aggregate to the database that is
// actually running. One aggregate, two repositories — which is what a
// repository is for.
//
// THE GUARANTEE IT ENFORCES: an extraction writes HERE, never to `candidate`.
// A value reaches a candidate record only through `review()`, which requires a
// named human, and only for fields that human accepted.

import { get, all, run, tx } from './db.js';
import { Candidates, encodeList } from './models.js';

/* ---------------------------- the aggregate ------------------------------- */

// Loaded from the compiled output: the aggregate is TypeScript and is the ONLY
// proposal model. A missing build is a deployment defect, not a reason to
// reimplement it here.
let CandidateProposal = null;
export async function loadAggregate() {
  if (CandidateProposal !== null) return CandidateProposal;
  const { pathToFileURL } = await import('node:url');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../../dist/modules/talent/domain/proposal.js',
  );
  try {
    ({ CandidateProposal } = await import(pathToFileURL(dist).href));
  } catch (error) {
    throw new Error(
      'The proposal aggregate is not built. Run `npm run build` in backend/. '
      + `(${error && error.message})`,
    );
  }
  return CandidateProposal;
}

/* ------------------------------- mapping ---------------------------------- */

const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value; // Postgres may hand back an object
  try { return JSON.parse(value); } catch { return fallback; }
};

/** Row -> the aggregate's state shape. Dates are real Dates in the domain. */
function toState(row) {
  const generation = parseJson(row.generation, null);
  return {
    id: row.id,
    tenantId: row.tenant_id ?? 1,
    candidateId: row.candidate_id,
    origin: row.origin,
    taskId: row.task_id ?? '',
    modelId: row.model_id ?? '',
    documentId: row.document_id ?? null,
    status: row.status,
    generation: generation === null ? null : {
      ...generation,
      generatedAt: new Date(generation.generatedAt),
    },
    fields: parseJson(row.fields, []),
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : new Date(),
    version: row.version ?? 0,
  };
}

const iso = (date) => (date instanceof Date ? date.toISOString() : date ?? null);

/* ------------------------------- the store -------------------------------- */

/**
 * Persist a proposal raised from a CV parse.
 *
 * Supersedes any pending proposal for the same candidate first: two live
 * proposals would leave a reviewer unable to tell which reflects the current
 * document.
 *
 * @returns {Promise<{ id: number, status: string, fields: object[] } | null>}
 *   null when there was nothing to propose.
 */
export async function raiseProposal(input) {
  const Aggregate = await loadAggregate();
  return raiseProposalIn(Aggregate, input);
}

/**
 * The synchronous core. Joins an outer transaction when there is one.
 *
 * Separate from the async wrapper because `tx()` callbacks must be synchronous:
 * an async callback would yield with the transaction open. A composed operation
 * resolves the aggregate first, then calls this inside its own transaction.
 */
export function raiseProposalIn(Aggregate, input) {
  if (!input.fields || input.fields.length === 0) return null;

  return tx(() => {
    const pending = get(
      'SELECT * FROM candidate_proposal WHERE candidate_id=? AND status=? LIMIT 1',
      [input.candidateId, 'PENDING'],
    );
    if (pending) {
      const stale = Aggregate.fromState(toState(pending));
      stale.supersede();
      const state = stale.toState();
      run('UPDATE candidate_proposal SET status=?, version=? WHERE id=?',
        [state.status, state.version, state.id]);
    }

    // The aggregate assigns ids; this row's id comes from the database, so the
    // insert happens first and the aggregate is constructed around it.
    const inserted = run(
      `INSERT INTO candidate_proposal
        (tenant_id, candidate_id, origin, task_id, model_id, document_id, status,
         generation, fields, version, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        1, input.candidateId, input.origin, input.taskId ?? '', input.modelId ?? '',
        input.documentId ?? null, 'PENDING',
        input.generation ? JSON.stringify(input.generation) : null,
        '[]', 0, new Date().toISOString(),
      ],
    );

    const id = inserted?.lastInsertRowid
      ?? get('SELECT id FROM candidate_proposal WHERE candidate_id=? AND status=? ORDER BY id DESC LIMIT 1',
        [input.candidateId, 'PENDING'])?.id;

    // The aggregate filters to the proposable whitelist and stamps every field
    // PENDING. Whatever it returns is what gets stored — never the raw input.
    const proposal = Aggregate.raise({
      id: Number(id),
      tenantId: 1,
      candidateId: input.candidateId,
      origin: input.origin,
      taskId: input.taskId ?? '',
      modelId: input.modelId ?? '',
      documentId: input.documentId ?? null,
      generation: input.generation ?? null,
      fields: input.fields,
      now: new Date(),
    });

    const state = proposal.toState();
    run('UPDATE candidate_proposal SET fields=? WHERE id=?',
      [JSON.stringify(state.fields), state.id]);

    return { id: state.id, status: state.status, fields: state.fields };
  });
}

/** The pending proposal for a candidate, or null. */
export function pendingProposal(candidateId) {
  const row = get(
    'SELECT * FROM candidate_proposal WHERE candidate_id=? AND status=? ORDER BY id DESC LIMIT 1',
    [candidateId, 'PENDING'],
  );
  return row ? toState(row) : null;
}

/** Every proposal for a candidate, newest first. For the review screen. */
export function proposalsFor(candidateId) {
  return all('SELECT * FROM candidate_proposal WHERE candidate_id=? ORDER BY id DESC',
    [candidateId]).map(toState);
}

export function proposalById(id) {
  const row = get('SELECT * FROM candidate_proposal WHERE id=?', [id]);
  return row ? toState(row) : null;
}

/* --------------------------- applying a review ---------------------------- */

/** Proposable field -> candidate column. Every proposable field has one. */
const COLUMN_BY_FIELD = {
  fullName: 'full_name',
  email: 'email',
  phone: 'phone',
  nationality: 'nationality',
  location: 'location',
  linkedinUrl: 'linkedin_url',
  currentCompany: 'current_company',
  currentPosition: 'current_position',
  yearsExperience: 'years_experience',
  noticePeriod: 'notice_period',
  university: 'university',
  major: 'major',
  graduationYear: 'graduation_year',
  skills: 'skills',
  languages: 'languages',
  certifications: 'certifications',
};

/** Columns holding a JSON array. Encoded on the way in, decoded on the way out. */
const LIST_FIELDS = new Set(['skills', 'languages', 'certifications']);

/** A review that cannot proceed. Carries an HTTP-ish reason for the route. */
export class ProposalReviewError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProposalReviewError';
    this.code = code; // 'not-pending' | 'incomplete' | 'stale' | 'unknown-field'
  }
}

/**
 * Record a reviewer's per-field decisions and apply what they accepted.
 *
 * THE ONLY PATH from a proposed value to a candidate record.
 *
 * The whole thing is ONE transaction — the proposal's new status, its field
 * decisions and the candidate update commit together or not at all. A partial
 * commit is the worst outcome available here: a proposal marked APPLIED whose
 * values never reached the candidate is indistinguishable from a successful
 * review, and nobody would ever look at it again.
 *
 * @param {number} proposalId
 * @param {Record<string, boolean>} decisions  COMPLETE map: every pending field
 * @param {{ id: number, fullName?: string }} actor  the human responsible
 * @param {{ expectedVersion?: number }} [opts]  optimistic concurrency guard
 */
export async function reviewProposal(proposalId, decisions, actor, opts = {}) {
  const Aggregate = await loadAggregate();
  return reviewProposalIn(Aggregate, proposalId, decisions, actor, opts);
}

/** The synchronous core. See raiseProposalIn. */
export function reviewProposalIn(Aggregate, proposalId, decisions, actor, opts = {}) {
  return tx(() => {
    // Re-read INSIDE the transaction: a proposal resolved by someone else
    // between the route's lookup and this write must lose, not overwrite.
    const row = get('SELECT * FROM candidate_proposal WHERE id=?', [proposalId]);
    if (!row) return null;

    const state0 = toState(row);

    if (state0.status !== 'PENDING') {
      // Covers both "already reviewed" and "superseded by a newer parse".
      throw new ProposalReviewError(
        `This proposal is ${state0.status} and can no longer be reviewed.`, 'not-pending',
      );
    }

    if (opts.expectedVersion !== undefined && Number(opts.expectedVersion) !== state0.version) {
      throw new ProposalReviewError(
        'This proposal changed since it was loaded. Reload it and review again.', 'stale',
      );
    }

    // A COMPLETE decision map is required at this boundary. The aggregate
    // treats an omitted field as REJECTED, which is the right default for a
    // deliberate review but the wrong one for a truncated request — a dropped
    // checkbox would silently discard a correct value.
    const pendingFields = state0.fields.map((f) => f.field);
    const missing = pendingFields.filter((f) => !(f in decisions));
    if (missing.length > 0) {
      throw new ProposalReviewError(
        `A decision is required for every proposed field. Missing: ${missing.join(', ')}.`,
        'incomplete',
      );
    }

    const proposal = Aggregate.fromState(state0);
    // Throws UnknownProposalFieldError for a field not on this proposal.
    proposal.review(decisions, { id: actor.id, name: actor.fullName ?? '' }, new Date());

    const state = proposal.toState();
    const patch = proposal.acceptedPatch();

    run(
      'UPDATE candidate_proposal SET status=?, fields=?, reviewed_by=?, reviewed_at=?, version=? WHERE id=?',
      [state.status, JSON.stringify(state.fields), state.reviewedBy,
        iso(state.reviewedAt), state.version, state.id],
    );

    const applied = [];
    const unapplied = [];
    const sets = [];
    const values = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = COLUMN_BY_FIELD[field];
      // Accepted, but the candidate table has nowhere to put it. Reported, not
      // dropped: a reviewer who accepted a value is entitled to know it did not
      // land anywhere.
      if (column === undefined) { unapplied.push(field); continue; }
      sets.push(`${column}=?`);
      // encodeList validates: a malformed list throws and takes the whole
      // transaction with it rather than storing something unreadable.
      values.push(LIST_FIELDS.has(field) ? encodeList(value) : value);
      applied.push(field);
    }

    if (sets.length > 0) {
      values.push(new Date().toISOString(), state.candidateId);
      run(`UPDATE candidate SET ${sets.join(', ')}, updated_at=? WHERE id=?`, values);
    }

    return {
      id: state.id,
      status: state.status,
      version: state.version,
      applied,
      unapplied,
      rejected: state.fields.filter((f) => f.decision === 'REJECTED').map((f) => f.field),
      candidate: Candidates.byId(state.candidateId),
    };
  });
}

/**
 * Which proposable fields the DEPLOYED candidate table can actually store.
 *
 * Exported so a test can assert the two lists have not drifted apart, and so the
 * review response can name what it could not apply.
 */
export const PERSISTABLE_PROPOSAL_FIELDS = Object.keys(COLUMN_BY_FIELD);
