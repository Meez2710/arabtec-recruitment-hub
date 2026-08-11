// Cross-context event-catalogue integrity.
//
// Item 6 of this slice: "formalize all business events, keep publishers abstract."
// Formalising is only real if the catalogue and the emitters cannot drift, so
// these tests drive every aggregate through its full lifecycle and assert that
// every type it actually emits is declared.

import { describe, expect, it } from 'vitest';
import {
  HIRING_EVENTS, HIRING_EVENT_TYPES, SIGNIFICANT_HIRING_EVENTS, isHiringEventType,
} from './hiring/domain/events.js';
import { INTERVIEW_EVENT_TYPES, isInterviewEventType } from './interview/domain/events.js';
import { OFFER_EVENT_TYPES, isOfferEventType } from './offer/domain/events.js';
import { Requisition, type Actor } from './hiring/domain/requisition.js';
import { Application } from './hiring/domain/application.js';
import { Interview } from './interview/domain/interview.js';
import { Offer } from './offer/domain/offer.js';

const REQUESTER: Actor = { id: 10, name: 'Requester' };
const APPROVER: Actor = { id: 20, name: 'Approver' };

/** Exercise the Requisition aggregate across its whole surface. */
function emitAllRequisitionEvents(): string[] {
  const seen: string[] = [];
  const drain = (r: Requisition) => seen.push(...r.pullEvents().map((e) => e.type));

  const r = Requisition.create({
    id: 1, tenantId: 1, ticketNo: 'REQ-1', title: 'X',
    projectId: 1, departmentId: 1, requesterId: REQUESTER.id, headcount: 2,
    createdBy: REQUESTER.id,
  });
  r.updateDetails({ title: 'Y' }, REQUESTER);
  r.submit(REQUESTER, { approvalRequired: true });
  r.approve(APPROVER);
  r.assignRecruiter(30, APPROVER);
  r.adjustHeadcount(3, APPROVER);
  r.fillSeat(500, APPROVER);
  r.releaseSeat(500, 'reversed', APPROVER);
  r.hold(APPROVER, 'freeze');
  r.resume(APPROVER);
  r.close(APPROVER, 'done');
  r.reopen(APPROVER, 'restart', 1);
  drain(r);
  return seen;
}

function emitAllApplicationEvents(): string[] {
  const seen: string[] = [];
  const a = Application.create({
    id: 1, tenantId: 1, applicationNo: 'APP-1', candidateId: 42,
    requisitionId: 7, recruiterId: 30, stage: 'SOURCED', actor: APPROVER,
  });
  a.transitionTo('MATCHED', APPROVER);
  a.setNextAction('call', null, APPROVER);
  a.assignRecruiter(31, APPROVER);
  a.transitionTo('ON_HOLD', APPROVER, { reason: 'travelling' });
  a.resume(APPROVER);
  a.transitionTo('INTERVIEWING', APPROVER);
  a.transitionTo('OFFER_PREPARATION', APPROVER);
  a.transitionTo('OFFER_SENT', APPROVER, { trigger: 'SYSTEM' });
  a.transitionTo('HIRED', APPROVER, { trigger: 'SYSTEM' });
  a.reverseHire(APPROVER, 'did not start');
  seen.push(...a.pullEvents().map((e) => e.type));
  return seen;
}

function emitAllInterviewEvents(): string[] {
  const now = new Date('2026-08-03T09:00:00Z');
  const later = new Date('2026-08-05T09:00:00Z');
  const iv = Interview.schedule({
    id: 1, tenantId: 1, interviewNo: 'IV-1', applicationId: 1, candidateId: 1,
    requisitionId: 1, round: 1, mode: 'VIDEO', startsAt: later, durationMinutes: 60,
    panel: [{ userId: 20, role: 'RECRUITER', isLead: true }],
    actor: APPROVER, now,
  });
  iv.reschedule(new Date('2026-08-06T09:00:00Z'), APPROVER, now);
  iv.setPanel([{ userId: 20, role: 'RECRUITER', isLead: true }], APPROVER);
  iv.recordAssessment({
    evaluatorUserId: 20, evaluatorName: 'R', scores: { openness: 4 }, now,
  });
  iv.recordAssessment({
    evaluatorUserId: 20, evaluatorName: 'R', scores: { openness: 5 }, allowUpdate: true, now,
  });
  iv.complete(APPROVER);
  return iv.pullEvents().map((e) => e.type);
}

function emitAllOfferEvents(): string[] {
  const now = new Date('2026-08-03T09:00:00Z');
  const components = ['BASIC_SALARY'];
  const seen: string[] = [];

  const make = () => Offer.draft({
    id: 1, tenantId: 1, offerNo: 'OFR-1', applicationId: 1, candidateId: 1, requisitionId: 1,
    positionTitle: 'X', currency: 'EGP',
    lines: [{ componentCode: 'BASIC_SALARY', amount: 1000 }],
    knownComponents: components, actor: REQUESTER,
  });

  // Path 1: draft -> submit -> approve -> send -> accept
  const o1 = make();
  o1.setCompensation([{ componentCode: 'BASIC_SALARY', amount: 2000 }], components, REQUESTER);
  o1.submit({ directorThreshold: 50_000, thresholdCurrency: 'EGP' }, REQUESTER);
  o1.approve(APPROVER, { hasDirectorAuthority: true });
  o1.send({
    templateCode: 'T', templateVersion: 1, variableSnapshot: {}, validityDays: 5,
    now, actor: APPROVER,
  });
  o1.accept(now, APPROVER);
  seen.push(...o1.pullEvents().map((e) => e.type));

  // Path 2: decline
  const o2 = make();
  o2.submit({ directorThreshold: 50_000, thresholdCurrency: 'EGP' }, REQUESTER);
  o2.approve(APPROVER, { hasDirectorAuthority: true });
  o2.send({
    templateCode: 'T', templateVersion: 1, variableSnapshot: {}, validityDays: 5,
    now, actor: APPROVER,
  });
  o2.decline('elsewhere', now, APPROVER);
  seen.push(...o2.pullEvents().map((e) => e.type));

  // Path 3: expire
  const o3 = make();
  o3.submit({ directorThreshold: 50_000, thresholdCurrency: 'EGP' }, REQUESTER);
  o3.approve(APPROVER, { hasDirectorAuthority: true });
  o3.send({
    templateCode: 'T', templateVersion: 1, variableSnapshot: {}, validityDays: 5,
    now, actor: APPROVER,
  });
  o3.expire(new Date('2026-08-20T09:00:00Z'), APPROVER);
  seen.push(...o3.pullEvents().map((e) => e.type));

  // Path 4: withdraw
  const o4 = make();
  o4.withdraw('cancelled', now, APPROVER);
  seen.push(...o4.pullEvents().map((e) => e.type));

  return seen;
}

describe('Event catalogue — no drift between emitters and declarations', () => {
  it('Hiring: every emitted type is declared', () => {
    const emitted = new Set([...emitAllRequisitionEvents(), ...emitAllApplicationEvents()]);
    for (const type of emitted) {
      expect(isHiringEventType(type), `undeclared hiring event: ${type}`).toBe(true);
    }
  });

  it('Hiring: every declared type is actually emitted', () => {
    const emitted = new Set([...emitAllRequisitionEvents(), ...emitAllApplicationEvents()]);
    for (const declared of HIRING_EVENT_TYPES) {
      expect(emitted.has(declared), `declared but never emitted: ${declared}`).toBe(true);
    }
  });

  it('Interview: every emitted type is declared', () => {
    for (const type of new Set(emitAllInterviewEvents())) {
      expect(isInterviewEventType(type), `undeclared interview event: ${type}`).toBe(true);
    }
  });

  it('Interview: every declared type is actually emitted', () => {
    const emitted = new Set(emitAllInterviewEvents());
    for (const declared of INTERVIEW_EVENT_TYPES) {
      expect(emitted.has(declared), `declared but never emitted: ${declared}`).toBe(true);
    }
  });

  it('Offer: every emitted type is declared', () => {
    for (const type of new Set(emitAllOfferEvents())) {
      expect(isOfferEventType(type), `undeclared offer event: ${type}`).toBe(true);
    }
  });

  it('Offer: every declared type is actually emitted', () => {
    const emitted = new Set(emitAllOfferEvents());
    for (const declared of OFFER_EVENT_TYPES) {
      expect(emitted.has(declared), `declared but never emitted: ${declared}`).toBe(true);
    }
  });
});

describe('Event catalogue — shape', () => {
  it('declares no duplicate type strings within a context', () => {
    for (const types of [HIRING_EVENT_TYPES, INTERVIEW_EVENT_TYPES, OFFER_EVENT_TYPES]) {
      expect(new Set(types).size).toBe(types.length);
    }
  });

  it('keeps type strings unique across contexts', () => {
    const all = [...HIRING_EVENT_TYPES, ...INTERVIEW_EVENT_TYPES, ...OFFER_EVENT_TYPES];
    expect(new Set(all).size).toBe(all.length);
  });

  it('marks a meaningful subset as user-visible activity', () => {
    expect(SIGNIFICANT_HIRING_EVENTS.length).toBeGreaterThan(0);
    for (const type of SIGNIFICANT_HIRING_EVENTS) {
      expect(isHiringEventType(type)).toBe(true);
    }
    // A headcount tweak should not read as loudly as a hire.
    expect(SIGNIFICANT_HIRING_EVENTS).not.toContain(HIRING_EVENTS.HEADCOUNT_ADJUSTED);
    expect(SIGNIFICANT_HIRING_EVENTS).toContain(HIRING_EVENTS.SEAT_FILLED);
  });

  it('carries identifiers a subscriber can act on without a lookup', () => {
    const r = Requisition.create({
      id: 5, tenantId: 1, ticketNo: 'REQ-5', title: 'X',
      projectId: 1, departmentId: 1, requesterId: 10, headcount: 1, createdBy: 10,
    });
    for (const event of r.pullEvents()) {
      expect(event.payload['requisitionId']).toBe(5);
      expect(event.at).toBeInstanceOf(Date);
    }
  });
});
