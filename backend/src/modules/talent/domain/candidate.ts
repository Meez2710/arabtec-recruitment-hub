// Candidate aggregate.
//
// FULLY MANUAL BY CONSTRUCTION. Nothing in this file references AI, a parser, an
// extraction or a proposal. A candidate can be created, edited, documented and
// archived by hand with no AI provider configured anywhere in the system — which
// is the required behaviour, and is why the aggregate has no AI dependency to
// make optional.
//
// AI reaches a candidate through exactly one door: `applyApprovedFields`, which
// a human calls after reviewing a proposal. From the aggregate's point of view
// that is just an edit that happens to carry provenance.
//
// Documents hold METADATA ONLY. Bytes live in a storage adapter; the aggregate
// records the hash, so dedup is by content rather than by filename — the same
// CV uploaded as `cv.pdf` and `cv (1).pdf` is one document.

import type { Actor, DomainEvent } from '../../shared/kernel/domain.js';
import { TALENT_EVENTS } from './events.js';
import {
  CandidateNotEditableError, ContactRequiredError, DocumentNotFoundError,
  DuplicateDocumentError, IllegalCandidateStateError, InvalidCandidateFieldError,
  InvalidDocumentTypeError,
} from './errors.js';
import { aiApprovedEntry, userEntry, withProvenance } from './provenance.js';
import type { FieldProvenance, ProvenanceMap } from './provenance.js';

/* ------------------------------- vocabulary -------------------------------- */

/** Mirrors the legacy `candidate_state`, which is NOT an application status. */
export const CANDIDATE_STATES = [
  'ACTIVE', 'DO_NOT_CONTACT', 'BLACKLISTED', 'MERGED', 'ERASED',
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

/** Terminal in the sense that the record is no longer a working record. */
const CLOSED_STATES: readonly CandidateState[] = ['MERGED', 'ERASED'];

export const DOCUMENT_TYPES = ['CV', 'CERTIFICATE', 'PORTFOLIO', 'ATTACHMENT'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Fields a proposal may write.
 *
 * A whitelist, not the whole props object: `state`, `ownerRecruiterId` and the
 * identifiers are decisions a person makes, and an extraction must never be able
 * to reach them however confident it is.
 */
/*
 * `noticePeriod` is deliberately NOT here. It is negotiated with the candidate
 * at interview, not printed on a CV, so parsing it meant proposing a value read
 * out of context for a recruiter to correct later. Expected salary, source and
 * tags are absent for the same reason and always have been — they are recorded
 * by the recruiter from the conversation, never inferred from the document.
 * The field stays fully editable by hand; only extraction is barred from it.
 */
export const PROPOSABLE_FIELDS = [
  'fullName', 'email', 'phone', 'nationality', 'location', 'linkedinUrl',
  'currentCompany', 'currentPosition', 'yearsExperience',
  'university', 'major', 'graduationYear', 'skills', 'languages', 'certifications',
] as const;
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];

export const isProposableField = (field: string): field is ProposableField =>
  (PROPOSABLE_FIELDS as readonly string[]).includes(field);

/* --------------------------------- shapes ---------------------------------- */

export interface CandidateDocument {
  readonly documentId: string;
  readonly docType: DocumentType;
  readonly fileName: string;
  /** Content hash. The dedup key, and the link to the stored bytes. */
  readonly fileHash: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly note: string | null;
  readonly uploadedBy: number | null;
  readonly uploadedAt: Date;
}

export interface CandidateProps {
  id: number;
  tenantId: number;
  candidateNo: string;

  fullName: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  location: string | null;
  linkedinUrl: string | null;

  currentCompany: string | null;
  currentPosition: string | null;
  yearsExperience: number | null;
  noticePeriod: string | null;

  university: string | null;
  major: string | null;
  graduationYear: number | null;

  skills: string[];
  languages: string[];
  certifications: string[];
  tags: string[];

  source: string | null;
  ownerRecruiterId: number | null;
  state: CandidateState;

  documents: CandidateDocument[];
  /** field -> where the current value came from. Absent means USER. */
  provenance: ProvenanceMap;

  createdBy: number;
  version: number;
}

/** The subset a caller may patch. Identity and state are not in it. */
export type CandidatePatch = Partial<Pick<CandidateProps,
  | 'fullName' | 'email' | 'phone' | 'nationality' | 'location' | 'linkedinUrl'
  | 'currentCompany' | 'currentPosition' | 'yearsExperience' | 'noticePeriod'
  | 'university' | 'major' | 'graduationYear'
  | 'skills' | 'languages' | 'certifications' | 'tags' | 'source'
>>;

const trimmed = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t === '' ? null : t;
};

const cleanList = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '') continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;   // case-insensitive dedup; first spelling wins
    seen.add(key);
    out.push(value);
  }
  return out;
};

export class Candidate {
  private readonly props: CandidateProps;
  private readonly events: DomainEvent[] = [];

  private constructor(props: CandidateProps) {
    this.props = props;
    this.assertInvariants();
  }

  static create(input: {
    id: number;
    tenantId: number;
    candidateNo: string;
    fullName: string;
    email?: string | null;
    phone?: string | null;
    source?: string | null;
    ownerRecruiterId?: number | null;
    /**
     * Fields whose seed value a human accepted from an extraction.
     *
     * Needed because `applyApprovedFields` only stamps fields it CHANGES, and
     * at creation the AI value is already the value. Without this, a candidate
     * built entirely from an accepted extraction would look entirely
     * user-entered — the exact distinction provenance exists to preserve.
     */
    approvedFrom?: { fields: readonly string[]; taskId: string; modelId: string };
    /**
     * Fields the creator explicitly supplied, stamped USER.
     *
     * Absent provenance already MEANS user-entered, so this is redundant for an
     * ordinary manual creation and is left unset there. It matters when a record
     * is built from a MIX — an intake conversion — where "this field is not
     * listed" and "a human typed this field" should not look the same to
     * whoever audits it later.
     */
    userFields?: readonly string[];
    actor: Actor;
    now: Date;
  } & CandidatePatch): Candidate {
    const fullName = trimmed(input.fullName);
    if (fullName === null) throw new InvalidCandidateFieldError('fullName', 'it is required');

    const candidate = new Candidate({
      id: input.id,
      tenantId: input.tenantId,
      candidateNo: input.candidateNo,
      fullName,
      email: trimmed(input.email),
      phone: trimmed(input.phone),
      nationality: trimmed(input.nationality),
      location: trimmed(input.location),
      linkedinUrl: trimmed(input.linkedinUrl),
      currentCompany: trimmed(input.currentCompany),
      currentPosition: trimmed(input.currentPosition),
      yearsExperience: input.yearsExperience ?? null,
      noticePeriod: trimmed(input.noticePeriod),
      university: trimmed(input.university),
      major: trimmed(input.major),
      graduationYear: input.graduationYear ?? null,
      skills: cleanList(input.skills ?? []),
      languages: cleanList(input.languages ?? []),
      certifications: cleanList(input.certifications ?? []),
      tags: cleanList(input.tags ?? []),
      source: trimmed(input.source),
      ownerRecruiterId: input.ownerRecruiterId ?? null,
      state: 'ACTIVE',
      documents: [],
      provenance: {},
      createdBy: input.actor.id,
      version: 0,
    });

    for (const field of input.userFields ?? []) {
      if (!isProposableField(field)) continue;
      candidate.props.provenance = withProvenance(
        candidate.props.provenance, [field], userEntry(input.actor.id, input.now),
      );
    }

    const approved = input.approvedFrom;
    if (approved !== undefined && approved.fields.length > 0) {
      const props = candidate.props as unknown as Record<string, unknown>;
      for (const field of approved.fields) {
        if (!isProposableField(field)) continue;
        candidate.props.provenance = withProvenance(
          candidate.props.provenance, [field], aiApprovedEntry({
            actorId: input.actor.id, at: input.now,
            taskId: approved.taskId, modelId: approved.modelId,
            value: props[field],
          }),
        );
      }
      candidate.record(TALENT_EVENTS.CANDIDATE_AI_FIELDS_APPROVED, {
        fields: [...approved.fields], taskId: approved.taskId, modelId: approved.modelId,
        by: input.actor.id, actorName: input.actor.name,
      });
    }

    candidate.record(TALENT_EVENTS.CANDIDATE_CREATED, {
      candidateNo: input.candidateNo, fullName, by: input.actor.id, actorName: input.actor.name,
    });
    return candidate;
  }

  static fromState(props: CandidateProps): Candidate {
    return new Candidate(props);
  }

  /* -------------------------------- readers -------------------------------- */

  get id(): number { return this.props.id; }
  get tenantId(): number { return this.props.tenantId; }
  get candidateNo(): string { return this.props.candidateNo; }
  get fullName(): string { return this.props.fullName; }
  get state(): CandidateState { return this.props.state; }
  get version(): number { return this.props.version; }
  get documents(): readonly CandidateDocument[] { return this.props.documents; }
  get provenance(): ProvenanceMap { return this.props.provenance; }
  get isEditable(): boolean { return !CLOSED_STATES.includes(this.props.state); }

  toState(): CandidateProps {
    return {
      ...this.props,
      skills: [...this.props.skills],
      languages: [...this.props.languages],
      certifications: [...this.props.certifications],
      tags: [...this.props.tags],
      documents: this.props.documents.map((d) => ({ ...d })),
      provenance: { ...this.props.provenance },
    };
  }

  pullEvents(): DomainEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /* -------------------------------- mutators ------------------------------- */

  /**
   * Manual edit. The ordinary path, and the only one that exists today.
   *
   * Every field touched is stamped USER — including one that previously held an
   * approved AI value. Once a human overwrites it, it is theirs.
   */
  update(patch: CandidatePatch, actor: Actor, now: Date): void {
    this.assertEditable();
    const changed = this.applyPatch(patch);
    if (changed.length === 0) return;

    this.props.provenance = withProvenance(
      this.props.provenance, changed, userEntry(actor.id, now),
    );
    this.touch();
    this.record(TALENT_EVENTS.CANDIDATE_UPDATED, {
      fields: changed, by: actor.id, actorName: actor.name,
    });
  }

  /**
   * Apply fields a human accepted from an AI proposal.
   *
   * Identical to `update` except for the provenance stamp — which is the point.
   * The domain does not treat an approved suggestion as special data; it treats
   * it as an edit whose origin is recorded. Validation, invariants and the
   * editable check all apply exactly as they do to typing.
   */
  applyApprovedFields(input: {
    patch: CandidatePatch;
    taskId: string;
    modelId: string;
    actor: Actor;
    now: Date;
  }): void {
    this.assertEditable();
    const changed = this.applyPatch(input.patch);
    if (changed.length === 0) return;

    for (const field of changed) {
      this.props.provenance = withProvenance(this.props.provenance, [field], aiApprovedEntry({
        actorId: input.actor.id,
        at: input.now,
        taskId: input.taskId,
        modelId: input.modelId,
        value: (this.props as unknown as Record<string, unknown>)[field],
      }));
    }
    this.touch();
    this.record(TALENT_EVENTS.CANDIDATE_AI_FIELDS_APPROVED, {
      fields: changed, taskId: input.taskId, modelId: input.modelId,
      by: input.actor.id, actorName: input.actor.name,
    });
  }

  assignOwner(recruiterId: number | null, actor: Actor): void {
    this.assertEditable();
    if (this.props.ownerRecruiterId === recruiterId) return;
    this.props.ownerRecruiterId = recruiterId;
    this.touch();
    this.record(TALENT_EVENTS.CANDIDATE_OWNER_ASSIGNED, {
      recruiterId, by: actor.id, actorName: actor.name,
    });
  }

  changeState(to: CandidateState, reason: string | null, actor: Actor): void {
    const from = this.props.state;
    if (from === to) return;
    // ERASED is final: the record has been redacted under a right-to-erasure
    // request and cannot be brought back.
    if (from === 'ERASED') throw new IllegalCandidateStateError(from, to);
    if (from === 'MERGED' && to !== 'ERASED') throw new IllegalCandidateStateError(from, to);

    this.props.state = to;
    this.touch();
    this.record(TALENT_EVENTS.CANDIDATE_STATE_CHANGED, {
      from, to, reason, by: actor.id, actorName: actor.name,
    });
  }

  attachDocument(document: Omit<CandidateDocument, 'uploadedAt'>, actor: Actor, now: Date): void {
    this.assertEditable();
    if (!(DOCUMENT_TYPES as readonly string[]).includes(document.docType)) {
      throw new InvalidDocumentTypeError(document.docType);
    }
    if (this.props.documents.some((d) => d.fileHash === document.fileHash)) {
      throw new DuplicateDocumentError(document.fileHash);
    }

    this.props.documents.push({ ...document, uploadedAt: now });
    this.touch();
    this.record(TALENT_EVENTS.DOCUMENT_ATTACHED, {
      documentId: document.documentId, docType: document.docType,
      fileName: document.fileName, fileHash: document.fileHash,
      by: actor.id, actorName: actor.name,
    });
  }

  removeDocument(documentId: string, actor: Actor): void {
    this.assertEditable();
    const index = this.props.documents.findIndex((d) => d.documentId === documentId);
    if (index < 0) throw new DocumentNotFoundError(documentId);

    const [removed] = this.props.documents.splice(index, 1);
    this.touch();
    this.record(TALENT_EVENTS.DOCUMENT_REMOVED, {
      documentId, docType: removed?.docType, by: actor.id, actorName: actor.name,
    });
  }

  /** The most recent CV, which is what an extraction would read. */
  latestCv(): CandidateDocument | undefined {
    return [...this.props.documents]
      .filter((d) => d.docType === 'CV')
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
  }

  /* -------------------------------- internals ------------------------------ */

  /** Returns the names of fields whose value actually changed. */
  private applyPatch(patch: CandidatePatch): string[] {
    const changed: string[] = [];
    const props = this.props as unknown as Record<string, unknown>;

    const setScalar = (field: string, value: string | null): void => {
      if (props[field] === value) return;
      props[field] = value;
      changed.push(field);
    };

    if (patch.fullName !== undefined) {
      const value = trimmed(patch.fullName);
      if (value === null) throw new InvalidCandidateFieldError('fullName', 'it is required');
      setScalar('fullName', value);
    }
    for (const field of [
      'email', 'phone', 'nationality', 'location', 'linkedinUrl',
      'currentCompany', 'currentPosition', 'noticePeriod', 'university', 'major', 'source',
    ] as const) {
      if (patch[field] !== undefined) setScalar(field, trimmed(patch[field]));
    }

    if (patch.yearsExperience !== undefined) {
      const value = patch.yearsExperience;
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 70)) {
        throw new InvalidCandidateFieldError('yearsExperience', 'it must be between 0 and 70');
      }
      if (this.props.yearsExperience !== value) {
        this.props.yearsExperience = value; changed.push('yearsExperience');
      }
    }

    if (patch.graduationYear !== undefined) {
      const value = patch.graduationYear;
      if (value !== null && (!Number.isInteger(value) || value < 1900 || value > 2200)) {
        throw new InvalidCandidateFieldError('graduationYear', 'it must be a plausible year');
      }
      if (this.props.graduationYear !== value) {
        this.props.graduationYear = value; changed.push('graduationYear');
      }
    }

    for (const field of ['skills', 'languages', 'certifications', 'tags'] as const) {
      const incoming = patch[field];
      if (incoming === undefined) continue;
      const next = cleanList(incoming);
      if (next.length !== this.props[field].length
        || next.some((v, i) => v !== this.props[field][i])) {
        this.props[field] = next;
        changed.push(field);
      }
    }

    return changed;
  }

  private assertEditable(): void {
    if (!this.isEditable) throw new CandidateNotEditableError(this.props.state);
  }

  /**
   * Checked on every construction, so corruption surfaces on LOAD rather than
   * at some later write — the same discipline as the other aggregates.
   */
  private assertInvariants(): void {
    if (this.props.fullName.trim() === '') {
      throw new InvalidCandidateFieldError('fullName', 'it is required');
    }
    // An ERASED record has been redacted; requiring contact details on it would
    // make erasure impossible.
    if (this.props.state !== 'ERASED'
      && this.props.email === null && this.props.phone === null) {
      throw new ContactRequiredError();
    }
    const hashes = new Set(this.props.documents.map((d) => d.fileHash));
    if (hashes.size !== this.props.documents.length) {
      throw new DuplicateDocumentError('(duplicate hash on load)');
    }
  }

  private touch(): void {
    this.props.version += 1;
    this.assertInvariants();
  }

  private record(type: string, payload: Record<string, unknown>): void {
    this.events.push({
      type,
      at: new Date(),
      payload: { candidateId: this.props.id, ...payload },
    });
  }
}

export type { FieldProvenance, ProvenanceMap };
