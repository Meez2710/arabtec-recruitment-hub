import { beforeEach, describe, expect, it } from 'vitest';
import { InterviewService, INTERVIEW_PERMISSIONS } from './interview-service.js';
import { AuthContext, ForbiddenError, NotFoundError } from '../../hiring/index.js';
import { RecordingEventBus } from '../../hiring/application/__testing__/in-memory.js';
import {
  FakeCalendarProvider, InMemoryInterviewStore, InMemoryInterviewUnitOfWork,
} from './__testing__/in-memory.js';
import {
  AssessmentNotAllowedError, DuplicateAssessmentError, IllegalInterviewTransitionError,
  InterviewReasonRequiredError, InvalidScoreError, NotAPanellistError,
  PanelRequiredError, SlotInPastError,
} from '../domain/errors.js';
import type { PanelMember } from '../domain/interview.js';

const NOW = new Date('2026-08-03T09:00:00Z');
const SOON = new Date('2026-08-05T10:00:00Z');
const LATER = new Date('2026-08-06T10:00:00Z');
const clock = { now: () => NOW };

const ALL = Object.values(INTERVIEW_PERMISSIONS);
function ctxFor(userId: number, permissions: readonly string[] = ALL): AuthContext {
  return new AuthContext({
    tenantId: 1, userId, userName: `User ${userId}`,
    permissions: [...permissions], projectScopes: [], isGlobalScope: true,
  });
}

const COORDINATOR = ctxFor(10);
const RECRUITER = ctxFor(20);       // completes the behavioural section
const HIRING_MANAGER = ctxFor(30);  // completes the technical section

const PANEL: PanelMember[] = [
  { userId: 20, role: 'RECRUITER', isLead: true },
  { userId: 30, role: 'HIRING_MANAGER', isLead: false },
];

interface Harness {
  store: InMemoryInterviewStore;
  uow: InMemoryInterviewUnitOfWork;
  events: RecordingEventBus;
  calendar: FakeCalendarProvider;
  service: InterviewService;
}

function harness(withCalendar = true): Harness {
  const store = new InMemoryInterviewStore();
  const uow = new InMemoryInterviewUnitOfWork(store);
  const events = new RecordingEventBus();
  const calendar = new FakeCalendarProvider();
  const service = new InterviewService({
    uow, events, clock, ...(withCalendar ? { calendar } : {}),
  });
  return { store, uow, events, calendar, service };
}

async function schedule(h: Harness, startsAt = SOON, panel = PANEL) {
  return h.service.schedule({
    applicationId: 100, candidateId: 42, requisitionId: 7,
    mode: 'VIDEO', startsAt, durationMinutes: 60, panel,
  }, COORDINATOR);
}

const GOOD_BEHAVIOURAL = {
  openness: 4, conscientiousness: 5, extraversion: 4,
  agreeableness: 4, emotional_stability: 5,
} as const;

const GOOD_TECHNICAL = {
  technical_knowledge: 5, relevant_experience: 4, problem_solving: 5,
  tools_software: 4, planning_organizing: 4,
} as const;

describe('InterviewService — scheduling', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('books an interview and derives the round number', async () => {
    const first = await schedule(h);
    expect(first.interview.status).toBe('SCHEDULED');
    expect(first.interview.round).toBe(1);
    expect(first.interview.panelUserIds).toEqual([20, 30]);

    const second = await schedule(h, LATER);
    expect(second.interview.round).toBe(2);
  });

  it('issues a calendar invitation and stores the external id', async () => {
    const result = await schedule(h);
    expect(result.calendarInvited).toBe(true);
    expect(h.calendar.created).toBe(1);
    expect(h.store.get(result.interview.id)!.externalEventId).toBe('ext-1');
  });

  // A slow or broken calendar must never undo a booked interview.
  it('still books the interview when the calendar fails', async () => {
    h.calendar.shouldFail = true;
    const result = await schedule(h);
    expect(result.calendarInvited).toBe(false);
    expect(h.store.get(result.interview.id)!.status).toBe('SCHEDULED');
  });

  it('works with no calendar provider configured at all', async () => {
    const h2 = harness(false);
    const result = await schedule(h2);
    expect(result.calendarInvited).toBe(false);
    expect(result.interview.status).toBe('SCHEDULED');
  });

  it('reports panel conflicts without blocking the booking', async () => {
    await schedule(h);
    const second = await schedule(h); // same slot, same panel
    expect(second.conflicts.length).toBeGreaterThan(0);
    expect(second.conflicts.map((c) => c.userId)).toContain(20);
    expect(second.interview.status).toBe('SCHEDULED'); // booked anyway
  });

  it('refuses an empty panel', async () => {
    await expect(schedule(h, SOON, [])).rejects.toThrow(PanelRequiredError);
  });

  it('refuses a slot in the past', async () => {
    await expect(schedule(h, new Date('2026-08-01T10:00:00Z'))).rejects.toThrow(SlotInPastError);
  });

  it('requires the schedule permission', async () => {
    await expect(h.service.schedule({
      applicationId: 1, candidateId: 1, requisitionId: 1,
      mode: 'ONSITE', startsAt: SOON, durationMinutes: 60, panel: PANEL,
    }, ctxFor(99, []))).rejects.toThrow(ForbiddenError);
  });
});

// BL-16 — 'RESCHEDULED' was a status, which hid interviews from every KPI.
describe('InterviewService — rescheduling keeps the interview visible', () => {
  it('bumps a counter and stays SCHEDULED', async () => {
    const h = harness();
    const { interview } = await schedule(h);

    const moved = await h.service.reschedule(interview.id, LATER, COORDINATOR);

    expect(moved.status).toBe('SCHEDULED');
    expect(moved.rescheduleCount).toBe(1);
    expect(h.store.get(interview.id)!.isUpcoming).toBe(true);
    expect(h.events.typesOf()).toContain('InterviewRescheduled');
  });

  it('refuses to reschedule into the past', async () => {
    const h = harness();
    const { interview } = await schedule(h);
    await expect(h.service.reschedule(interview.id, new Date('2026-07-01T10:00:00Z'), COORDINATOR))
      .rejects.toThrow(SlotInPastError);
  });
});

describe('InterviewService — status machine (BL-17)', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it('completes a scheduled interview', async () => {
    const { interview } = await schedule(h);
    expect((await h.service.complete(interview.id, COORDINATOR)).status).toBe('COMPLETED');
  });

  it('refuses to move out of a completed interview', async () => {
    const { interview } = await schedule(h);
    await h.service.complete(interview.id, COORDINATOR);
    await expect(h.service.markNoShow(interview.id, COORDINATOR))
      .rejects.toThrow(IllegalInterviewTransitionError);
  });

  it('cancels with a reason and cancels the calendar event', async () => {
    const { interview } = await schedule(h);
    const cancelled = await h.service.cancel(interview.id, 'candidate withdrew', COORDINATOR);
    expect(cancelled.status).toBe('CANCELLED');
    expect(h.calendar.cancelled).toContain('ext-1');
  });

  it('requires a reason to cancel', async () => {
    const { interview } = await schedule(h);
    await expect(h.service.cancel(interview.id, '  ', COORDINATOR))
      .rejects.toThrow(InterviewReasonRequiredError);
  });

  it('lets a no-show be re-booked', async () => {
    const { interview } = await schedule(h);
    await h.service.markNoShow(interview.id, COORDINATOR);
    const rebooked = await h.service.reschedule(interview.id, LATER, COORDINATOR);
    expect(rebooked.status).toBe('SCHEDULED');
  });
});

describe('InterviewService — assessment', () => {
  let h: Harness;
  let interviewId: number;

  beforeEach(async () => {
    h = harness();
    interviewId = (await schedule(h)).interview.id;
    h.events.reset();
  });

  it('records a panellist assessment against their own section', async () => {
    await h.service.recordAssessment(
      { interviewId, scores: GOOD_BEHAVIOURAL, justification: 'Strong evidence' }, RECRUITER,
    );
    const stored = h.store.get(interviewId)!;
    expect(stored.assessments).toHaveLength(1);
    expect(stored.assessments[0]!.evaluatorRole).toBe('RECRUITER');
    expect(h.events.typesOf()).toContain('InterviewAssessmentRecorded');
  });

  it('refuses feedback from someone not on the panel', async () => {
    await expect(h.service.recordAssessment(
      { interviewId, scores: GOOD_BEHAVIOURAL }, ctxFor(99),
    )).rejects.toThrow(NotAPanellistError);
  });

  it('refuses a criterion outside the evaluator’s own section', async () => {
    await expect(h.service.recordAssessment(
      { interviewId, scores: GOOD_TECHNICAL }, RECRUITER, // technical keys, behavioural role
    )).rejects.toThrow(InvalidScoreError);
  });

  it('refuses an out-of-range score', async () => {
    await expect(h.service.recordAssessment(
      { interviewId, scores: { openness: 9 as never } }, RECRUITER,
    )).rejects.toThrow(InvalidScoreError);
  });

  it('accepts N/A without counting it against the average', async () => {
    await h.service.recordAssessment(
      { interviewId, scores: { openness: 4, conscientiousness: 'NA' } }, RECRUITER,
    );
    const rec = await h.service.recommendation(interviewId, RECRUITER);
    expect(rec.behaviouralAverage).toBe(4);
  });

  it('blocks a second submission unless an update is requested', async () => {
    await h.service.recordAssessment({ interviewId, scores: GOOD_BEHAVIOURAL }, RECRUITER);
    await expect(h.service.recordAssessment({ interviewId, scores: GOOD_BEHAVIOURAL }, RECRUITER))
      .rejects.toThrow(DuplicateAssessmentError);

    await h.service.recordAssessment(
      { interviewId, scores: { openness: 3 }, allowUpdate: true }, RECRUITER,
    );
    expect(h.store.get(interviewId)!.assessments).toHaveLength(1);
  });

  // BL-17 — feedback was accepted for interviews that never happened.
  it.each(['CANCELLED', 'NO_SHOW'] as const)(
    'refuses feedback on a %s interview', async (target) => {
      if (target === 'CANCELLED') await h.service.cancel(interviewId, 'x', COORDINATOR);
      else await h.service.markNoShow(interviewId, COORDINATOR);

      await expect(h.service.recordAssessment({ interviewId, scores: GOOD_BEHAVIOURAL }, RECRUITER))
        .rejects.toThrow(AssessmentNotAllowedError);
    },
  );

  it('requires the feedback permission', async () => {
    await expect(h.service.recordAssessment(
      { interviewId, scores: GOOD_BEHAVIOURAL }, ctxFor(20, []),
    )).rejects.toThrow(ForbiddenError);
  });
});

describe('InterviewService — rule-based recommendation', () => {
  let h: Harness;
  let interviewId: number;

  beforeEach(async () => {
    h = harness();
    interviewId = (await schedule(h)).interview.id;
  });

  it('holds while the panel has not finished', async () => {
    await h.service.recordAssessment({ interviewId, scores: GOOD_BEHAVIOURAL }, RECRUITER);
    const rec = await h.service.recommendation(interviewId, RECRUITER);
    expect(rec.complete).toBe(false);
    expect(rec.suggestedDecision).toBe('HOLD');
  });

  it('suggests PROCEED when both sections are strong', async () => {
    await h.service.recordAssessment({ interviewId, scores: GOOD_BEHAVIOURAL }, RECRUITER);
    await h.service.recordAssessment({ interviewId, scores: GOOD_TECHNICAL }, HIRING_MANAGER);

    const rec = await h.service.recommendation(interviewId, RECRUITER);
    expect(rec.complete).toBe(true);
    expect(rec.behaviouralFit).toBe('STRONG');
    expect(rec.technicalFit).toBe('STRONG');
    expect(rec.suggestedDecision).toBe('PROCEED');
  });

  it('never suggests PROCEED while a critical flag is raised', async () => {
    await h.service.recordAssessment(
      { interviewId, scores: GOOD_BEHAVIOURAL, criticalFlags: { cv_inconsistency: true } },
      RECRUITER,
    );
    await h.service.recordAssessment({ interviewId, scores: GOOD_TECHNICAL }, HIRING_MANAGER);

    const rec = await h.service.recommendation(interviewId, RECRUITER);
    expect(rec.criticalFlagsRaised).toBe(true);
    expect(rec.suggestedDecision).toBe('PROCEED_WITH_CONDITIONS');
  });

  it('suggests REJECT when the weakest section is below the borderline band', async () => {
    await h.service.recordAssessment({
      interviewId,
      scores: { openness: 2, conscientiousness: 2, extraversion: 2,
        agreeableness: 2, emotional_stability: 2 },
    }, RECRUITER);
    await h.service.recordAssessment({ interviewId, scores: GOOD_TECHNICAL }, HIRING_MANAGER);

    const rec = await h.service.recommendation(interviewId, RECRUITER);
    expect(rec.behaviouralFit).toBe('WEAK');
    expect(rec.suggestedDecision).toBe('REJECT');
  });

  it('returns nulls when nothing has been scored', async () => {
    const rec = await h.service.recommendation(interviewId, RECRUITER);
    expect(rec.behaviouralAverage).toBeNull();
    expect(rec.suggestedDecision).toBeNull();
    expect(rec.assessmentsSubmitted).toBe(0);
  });

  it('lets a panellist read it, and refuses an outsider without the org-wide view', async () => {
    await expect(h.service.recommendation(interviewId, ctxFor(99, [])))
      .rejects.toThrow(ForbiddenError);
    await expect(h.service.recommendation(interviewId, ctxFor(99, [INTERVIEW_PERMISSIONS.VIEW_ALL])))
      .resolves.toBeDefined();
  });

  it('reports NOT_FOUND for a missing interview', async () => {
    await expect(h.service.recommendation(999, RECRUITER)).rejects.toThrow(NotFoundError);
  });
});

describe('InterviewService — panel changes', () => {
  it('replaces the panel and keeps exactly one lead', async () => {
    const h = harness();
    const { interview } = await schedule(h);
    await h.service.setPanel(interview.id, [
      { userId: 40, role: 'RECRUITER', isLead: false },
      { userId: 41, role: 'HIRING_MANAGER', isLead: true },
    ], COORDINATOR);

    const stored = h.store.get(interview.id)!;
    expect(stored.panel.map((p) => p.userId)).toEqual([40, 41]);
    expect(stored.panel.filter((p) => p.isLead)).toHaveLength(1);
    expect(h.events.typesOf()).toContain('InterviewPanelChanged');
  });

  it('refuses an empty panel', async () => {
    const h = harness();
    const { interview } = await schedule(h);
    await expect(h.service.setPanel(interview.id, [], COORDINATOR))
      .rejects.toThrow(PanelRequiredError);
  });
});
