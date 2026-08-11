// Interview mapper tests — pure, no database.

import { describe, expect, it } from 'vitest';
import { Interview } from '../domain/interview.js';
import type { Actor } from '../../shared/kernel/domain.js';
import {
  assessmentToRow, interviewToProps, interviewToRow, panelToRow,
} from './mappers.js';
import type { AssessmentRow, InterviewRow, PanelRow } from './mappers.js';

const ACTOR: Actor = { id: 7, name: 'Mona Adel' };
const NOW = new Date('2026-03-01T09:00:00.000Z');

const asInterviewRow = (insert: ReturnType<typeof interviewToRow>): InterviewRow => ({
  ...insert,
  id: insert.id ?? 0,
  tenantId: insert.tenantId ?? 1,
  locationOrLink: insert.locationOrLink ?? null,
  rescheduleCount: insert.rescheduleCount ?? 0,
  lastRescheduledAt: insert.lastRescheduledAt ?? null,
  cancelReason: insert.cancelReason ?? null,
  externalEventId: insert.externalEventId ?? null,
  version: insert.version ?? 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
});

const asPanelRows = (
  interviewId: number,
  panel: ReturnType<Interview['toState']>['panel'],
): PanelRow[] => panel.map((m, i) => ({
  ...panelToRow(interviewId, m),
  id: i + 1,
  isLead: m.isLead,
}));

const asAssessmentRows = (
  interviewId: number,
  assessments: ReturnType<Interview['toState']>['assessments'],
): AssessmentRow[] => assessments.map((a, i) => ({
  ...assessmentToRow(interviewId, a),
  id: i + 1,
  scores: a.scores,
  criticalFlags: a.criticalFlags,
  justification: a.justification,
}));

const roundTrip = (iv: Interview): ReturnType<Interview['toState']> => {
  const state = iv.toState();
  return interviewToProps(
    asInterviewRow(interviewToRow(state)),
    // Shuffled — the mapper imposes lead-first ordering itself.
    [...asPanelRows(state.id, state.panel)].reverse(),
    [...asAssessmentRows(state.id, state.assessments)].reverse(),
  );
};

const schedule = (): Interview => Interview.schedule({
  id: 41, tenantId: 1, interviewNo: 'INT-00041',
  applicationId: 31, candidateId: 501, requisitionId: 11,
  round: 1, mode: 'ONSITE', startsAt: new Date('2026-04-01T09:00:00.000Z'),
  durationMinutes: 60, locationOrLink: 'Meeting Room 2',
  panel: [
    { userId: 11, role: 'RECRUITER', isLead: true },
    { userId: 12, role: 'HIRING_MANAGER', isLead: false },
  ],
  actor: ACTOR, now: NOW,
});

describe('interview mapper', () => {
  it('round-trips a scheduled interview with its panel', () => {
    const iv = schedule();
    expect(roundTrip(iv)).toEqual(iv.toState());
  });

  it('round-trips a rescheduled interview — counter, not status (BL-16)', () => {
    const iv = schedule();
    iv.reschedule(new Date('2026-04-03T09:00:00.000Z'), ACTOR, new Date('2026-03-05T09:00:00.000Z'));
    iv.reschedule(new Date('2026-04-05T09:00:00.000Z'), ACTOR, new Date('2026-03-06T09:00:00.000Z'));

    const restored = roundTrip(iv);
    expect(restored).toEqual(iv.toState());
    expect(restored.status).toBe('SCHEDULED');
    expect(restored.rescheduleCount).toBe(2);
  });

  it('round-trips assessments with NA scores and critical flags intact', () => {
    const iv = schedule();
    iv.recordAssessment({
      evaluatorUserId: 11, evaluatorName: 'Mona Adel',
      scores: {
        openness: 4, conscientiousness: 'NA', extraversion: 3,
        agreeableness: 5, emotional_stability: 4,
      },
      criticalFlags: { attendance_risk: true, integrity_concern: false },
      justification: 'strong on site experience',
      now: new Date('2026-04-01T10:30:00.000Z'),
    });

    const restored = roundTrip(iv);
    expect(restored).toEqual(iv.toState());
    // 'NA' must survive as the string it is — coercing it to 0 or null would
    // silently change the fit score, since NA is excluded from the denominator.
    expect(restored.assessments[0]?.scores['conscientiousness']).toBe('NA');
    expect(restored.assessments[0]?.criticalFlags).toEqual({
      attendance_risk: true, integrity_concern: false,
    });
  });

  it('round-trips a cancelled interview with its reason', () => {
    const iv = schedule();
    iv.cancel('candidate unavailable', ACTOR);
    const restored = roundTrip(iv);
    expect(restored).toEqual(iv.toState());
    expect(restored.cancelReason).toBe('candidate unavailable');
  });

  it('round-trips a bound external calendar event', () => {
    const iv = schedule();
    iv.bindExternalEvent('goog-evt-abc123');
    expect(roundTrip(iv).externalEventId).toBe('goog-evt-abc123');
  });

  it('treats null jsonb columns as empty records', () => {
    const iv = schedule();
    const state = iv.toState();
    const row: AssessmentRow = {
      id: 1, interviewId: state.id, evaluatorUserId: 11, evaluatorRole: 'RECRUITER',
      evaluatorName: 'Mona Adel', scores: null, criticalFlags: null,
      justification: '', submittedAt: NOW,
    };
    const restored = interviewToProps(
      asInterviewRow(interviewToRow(state)),
      asPanelRows(state.id, state.panel),
      [row],
    );
    expect(restored.assessments[0]?.scores).toEqual({});
    expect(restored.assessments[0]?.criticalFlags).toEqual({});
  });
});
