// Talent domain tests — pure, no database.

import { describe, expect, it } from 'vitest';
import { Candidate } from './domain/candidate.js';
import { CandidateProposal } from './domain/proposal.js';
import { sourceOf, aiApprovedFields } from './domain/provenance.js';
import {
  CandidateNotEditableError, ContactRequiredError, DuplicateDocumentError,
  IllegalCandidateStateError, InvalidCandidateFieldError, ProposalAlreadyResolvedError,
  UnknownProposalFieldError,
} from './domain/errors.js';
import type { Actor } from '../shared/kernel/domain.js';

const ACTOR: Actor = { id: 7, name: 'Mona Adel' };
const REVIEWER: Actor = { id: 9, name: 'Reviewer' };
const NOW = new Date('2026-08-01T09:00:00.000Z');

const aCandidate = (over: Record<string, unknown> = {}): Candidate => Candidate.create({
  id: 1, tenantId: 1, candidateNo: 'CAN-00001',
  fullName: 'Ahmed Hassan', email: 'ahmed@example.com',
  actor: ACTOR, now: NOW, ...over,
});

const aDocument = (hash: string, over: Record<string, unknown> = {}): Parameters<
  Candidate['attachDocument']
>[0] => ({
  documentId: `doc-${hash}`, docType: 'CV', fileName: 'cv.pdf',
  fileHash: hash, fileSize: 1024, mimeType: 'application/pdf',
  note: null, uploadedBy: 7, ...over,
});

/* -------------------------- manual, without AI ----------------------------- */

describe('Candidate — manual management', () => {
  it('creates and edits with no AI involved anywhere', () => {
    const candidate = aCandidate();
    expect(candidate.state).toBe('ACTIVE');
    expect(candidate.version).toBe(0);

    candidate.update({ currentCompany: 'Orascom', skills: ['AutoCAD', 'Primavera'] }, ACTOR, NOW);
    const state = candidate.toState();
    expect(state.currentCompany).toBe('Orascom');
    expect(state.skills).toEqual(['AutoCAD', 'Primavera']);
    // Everything a human typed is USER, and that is the default.
    expect(sourceOf(state.provenance, 'currentCompany')).toBe('USER');
    expect(sourceOf(state.provenance, 'neverTouched')).toBe('USER');
  });

  it('requires a name and at least one way to make contact', () => {
    expect(() => aCandidate({ fullName: '   ' })).toThrow(InvalidCandidateFieldError);
    expect(() => aCandidate({ email: null, phone: null })).toThrow(ContactRequiredError);
    // Either channel alone is enough.
    expect(() => aCandidate({ email: null, phone: '+201001234567' })).not.toThrow();
  });

  it('rejects implausible values rather than storing them', () => {
    const candidate = aCandidate();
    expect(() => candidate.update({ yearsExperience: 200 }, ACTOR, NOW))
      .toThrow(InvalidCandidateFieldError);
    expect(() => candidate.update({ graduationYear: 1200 }, ACTOR, NOW))
      .toThrow(InvalidCandidateFieldError);
    expect(() => candidate.update({ fullName: '' }, ACTOR, NOW))
      .toThrow(InvalidCandidateFieldError);
  });

  it('does not bump the version when nothing actually changed', () => {
    const candidate = aCandidate();
    candidate.update({ fullName: 'Ahmed Hassan' }, ACTOR, NOW);
    expect(candidate.version).toBe(0);
    expect(candidate.pullEvents().filter((e) => e.type === 'CandidateUpdated')).toHaveLength(0);
  });

  it('deduplicates list values case-insensitively, keeping the first spelling', () => {
    const candidate = aCandidate();
    candidate.update({ skills: ['AutoCAD', 'autocad', ' AutoCAD ', 'Revit'] }, ACTOR, NOW);
    expect(candidate.toState().skills).toEqual(['AutoCAD', 'Revit']);
  });

  it('attaches documents and refuses the same bytes twice', () => {
    const candidate = aCandidate();
    candidate.attachDocument(aDocument('a'.repeat(64)), ACTOR, NOW);
    // Different filename, same content — one document.
    expect(() => candidate.attachDocument(
      aDocument('a'.repeat(64), { fileName: 'cv (1).pdf', documentId: 'other' }), ACTOR, NOW,
    )).toThrow(DuplicateDocumentError);
    expect(candidate.documents).toHaveLength(1);
  });

  it('reports the latest CV, ignoring other attachments', () => {
    const candidate = aCandidate();
    candidate.attachDocument(aDocument('a'.repeat(64)), ACTOR, new Date('2026-01-01'));
    candidate.attachDocument(
      aDocument('b'.repeat(64), { documentId: 'd2' }), ACTOR, new Date('2026-06-01'),
    );
    candidate.attachDocument(
      aDocument('c'.repeat(64), { documentId: 'd3', docType: 'CERTIFICATE' }),
      ACTOR, new Date('2026-07-01'),
    );
    expect(candidate.latestCv()?.fileHash).toBe('b'.repeat(64));
  });

  it('blocks editing once the record is merged or erased', () => {
    const candidate = aCandidate();
    candidate.changeState('MERGED', 'duplicate of CAN-00002', ACTOR);
    expect(() => candidate.update({ location: 'Cairo' }, ACTOR, NOW))
      .toThrow(CandidateNotEditableError);
  });

  it('treats erasure as final', () => {
    const candidate = aCandidate();
    candidate.changeState('ERASED', 'right to erasure', ACTOR);
    expect(() => candidate.changeState('ACTIVE', null, ACTOR)).toThrow(IllegalCandidateStateError);
  });

  it('allows an erased record to have no contact details', () => {
    // Requiring them would make erasure impossible.
    const candidate = aCandidate();
    candidate.changeState('ERASED', 'right to erasure', ACTOR);
    expect(() => Candidate.fromState({
      ...candidate.toState(), email: null, phone: null,
    })).not.toThrow();
  });
});

/* ----------------------------- provenance ---------------------------------- */

describe('provenance', () => {
  it('distinguishes user-entered from approved AI data', () => {
    const candidate = aCandidate();
    candidate.update({ location: 'Cairo' }, ACTOR, NOW);
    candidate.applyApprovedFields({
      patch: { currentPosition: 'Site Engineer', skills: ['Revit'] },
      taskId: 'task-1', modelId: 'model-x', actor: REVIEWER, now: NOW,
    });

    const state = candidate.toState();
    expect(sourceOf(state.provenance, 'location')).toBe('USER');
    expect(sourceOf(state.provenance, 'currentPosition')).toBe('AI_APPROVED');
    expect([...aiApprovedFields(state.provenance)].sort()).toEqual(['currentPosition', 'skills']);

    const entry = state.provenance['currentPosition'];
    expect(entry).toMatchObject({ taskId: 'task-1', modelId: 'model-x', actorId: REVIEWER.id });
    // The value the human saw when they accepted is recorded with it.
    expect(entry?.acceptedValue).toBe('Site Engineer');
  });

  it('reverts a field to USER when a human overwrites approved AI data', () => {
    const candidate = aCandidate();
    candidate.applyApprovedFields({
      patch: { location: 'Alexandria' }, taskId: 't', modelId: 'm', actor: REVIEWER, now: NOW,
    });
    expect(sourceOf(candidate.toState().provenance, 'location')).toBe('AI_APPROVED');

    candidate.update({ location: 'Cairo' }, ACTOR, NOW);
    // "Approved AI data" must mean the value STILL STANDING was approved, not
    // merely that AI once touched the field.
    expect(sourceOf(candidate.toState().provenance, 'location')).toBe('USER');
  });

  it('validates approved AI values exactly as it validates typed ones', () => {
    const candidate = aCandidate();
    expect(() => candidate.applyApprovedFields({
      patch: { yearsExperience: 500 }, taskId: 't', modelId: 'm', actor: REVIEWER, now: NOW,
    })).toThrow(InvalidCandidateFieldError);
  });

  it('emits an event naming the approved fields and their origin', () => {
    const candidate = aCandidate();
    candidate.pullEvents();
    candidate.applyApprovedFields({
      patch: { nationality: 'Egyptian' }, taskId: 'task-9', modelId: 'model-y',
      actor: REVIEWER, now: NOW,
    });
    const event = candidate.pullEvents().find((e) => e.type === 'CandidateAIFieldsApproved');
    expect(event?.payload).toMatchObject({
      fields: ['nationality'], taskId: 'task-9', modelId: 'model-y',
    });
  });
});

/* ------------------------------- proposals --------------------------------- */

describe('CandidateProposal', () => {
  const aProposal = (fields: readonly { field: string; value: unknown }[] = [
    { field: 'fullName', value: 'Ahmed H. Hassan' },
    { field: 'phone', value: '+201001234567' },
  ]): CandidateProposal => CandidateProposal.raise({
    id: 1, tenantId: 1, candidateId: 1, origin: 'resume.extract',
    taskId: 'task-1', modelId: 'model-x', fields, now: NOW,
  });

  it('drops fields a reviewer would not be allowed to accept', () => {
    const proposal = aProposal([
      { field: 'fullName', value: 'X' },
      { field: 'state', value: 'BLACKLISTED' },
      { field: 'ownerRecruiterId', value: 99 },
    ]);
    // Filtered at the boundary rather than stored and refused later — the
    // reviewer should never be offered them.
    expect(proposal.fields.map((f) => f.field)).toEqual(['fullName']);
  });

  it('accepts per field, and rejects everything left out', () => {
    const proposal = aProposal();
    proposal.review({ fullName: true }, REVIEWER, NOW);

    expect(proposal.status).toBe('APPLIED');
    expect(proposal.acceptedFields().map((f) => f.field)).toEqual(['fullName']);
    // An omitted field is REJECTED, not left pending — a half-reviewed proposal
    // sitting in a queue forever is how a queue stops being trusted.
    expect(proposal.fields.find((f) => f.field === 'phone')?.decision).toBe('REJECTED');
    expect(proposal.acceptedPatch()).toEqual({ fullName: 'Ahmed H. Hassan' });
  });

  it('is REJECTED when nothing was accepted', () => {
    const proposal = aProposal();
    proposal.review({}, REVIEWER, NOW);
    expect(proposal.status).toBe('REJECTED');
  });

  it('cannot be reviewed twice', () => {
    const proposal = aProposal();
    proposal.review({ fullName: true }, REVIEWER, NOW);
    expect(() => proposal.review({ phone: true }, REVIEWER, NOW))
      .toThrow(ProposalAlreadyResolvedError);
  });

  it('refuses a decision on a field it never offered', () => {
    const proposal = aProposal();
    expect(() => proposal.review({ email: true }, REVIEWER, NOW))
      .toThrow(UnknownProposalFieldError);
  });

  it('clamps confidence and defaults it to zero', () => {
    const proposal = CandidateProposal.raise({
      id: 1, tenantId: 1, candidateId: 1, origin: 'x', now: NOW,
      fields: [
        { field: 'fullName', value: 'A', confidence: 5 },
        { field: 'phone', value: 'B', confidence: -1 },
        { field: 'location', value: 'C' },
      ],
    });
    expect(proposal.fields.map((f) => f.confidence)).toEqual([1, 0, 0]);
  });

  it('supersedes silently, and only while pending', () => {
    const proposal = aProposal();
    proposal.supersede();
    expect(proposal.status).toBe('SUPERSEDED');

    const reviewed = aProposal();
    reviewed.review({ fullName: true }, REVIEWER, NOW);
    reviewed.supersede();
    expect(reviewed.status).toBe('APPLIED');
  });

  it('carries no AI vocabulary — a bulk import uses the same workflow', () => {
    const imported = CandidateProposal.raise({
      id: 2, tenantId: 1, candidateId: 1, origin: 'bulk.import', now: NOW,
      fields: [{ field: 'location', value: 'Cairo' }],
    });
    expect(imported.taskId).toBe('');
    expect(imported.modelId).toBe('');
    imported.review({ location: true }, REVIEWER, NOW);
    expect(imported.status).toBe('APPLIED');
  });
});
