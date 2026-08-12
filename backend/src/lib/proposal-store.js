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
import { Candidates } from './models.js';

/* ---------------------------- the aggregate ------------------------------- */

// Loaded from the compiled output: the aggregate is TypeScript and is the ONLY
// proposal model. A missing build is a deployment defect, not a reason to
// reimplement it here.
let CandidateProposal = null;
async function aggregate() {
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
  const Aggregate = await aggregate();
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

/**
 * Proposable field -> candidate column.
 *
 * Fields with no column — skills, languages, certifications — are deliberately
 * absent: the candidate table has nowhere to put them, and inventing a column
 * would be a schema change this migration does not make. They stay on the
 * proposal and are reported as unapplied rather than silently dropped.
 */
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
};

/**
 * Record a reviewer's per-field decisions and apply what they accepted.
 *
 * THE ONLY PATH from a proposed value to a candidate record. The aggregate
 * decides what "accepted" means and refuses a second review; this function only
 * writes the resulting patch.
 *
 * @param {number} proposalId
 * @param {Record<string, boolean>} decisions  field -> accept?
 * @param {{ id: number, fullName?: string }} actor  the human responsible
 */
export async function reviewProposal(proposalId, decisions, actor) {
  const Aggregate = await aggregate();
  const row = get('SELECT * FROM candidate_proposal WHERE id=?', [proposalId]);
  if (!row) return null;

  const proposal = Aggregate.fromState(toState(row));
  // Throws ProposalAlreadyResolvedError / UnknownProposalFieldError — the
  // domain's rules, surfaced to the route unchanged.
  proposal.review(decisions, { id: actor.id, name: actor.fullName ?? '' }, new Date());

  const state = proposal.toState();
  const patch = proposal.acceptedPatch();

  return tx(() => {
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
      if (column === undefined) { unapplied.push(field); continue; }
      sets.push(`${column}=?`);
      values.push(value);
      applied.push(field);
    }

    if (sets.length > 0) {
      values.push(new Date().toISOString(), state.candidateId);
      run(`UPDATE candidate SET ${sets.join(', ')}, updated_at=? WHERE id=?`, values);
    }

    return {
      id: state.id,
      status: state.status,
      applied,
      unapplied,
      rejected: state.fields.filter((f) => f.decision === 'REJECTED').map((f) => f.field),
      candidate: Candidates.byId(state.candidateId),
    };
  });
}
