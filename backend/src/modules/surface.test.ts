// Module boundary contracts. Other modules import from index.ts and nowhere else,
// so these pin what each one publishes — and what it deliberately withholds.

import { describe, expect, it } from 'vitest';
import * as interviews from './interview/index.js';
import * as offers from './offer/index.js';

describe('Interview module public surface', () => {
  it('exports the service, permissions and status vocabulary', () => {
    expect(typeof interviews.InterviewService).toBe('function');
    expect(interviews.INTERVIEW_PERMISSIONS.FEEDBACK).toBe('interview.feedback');
    expect(interviews.INTERVIEW_STATUSES).toEqual(
      ['SCHEDULED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'],
    );
    // BL-16 — RESCHEDULED must never become a status again.
    expect(interviews.INTERVIEW_STATUSES).not.toContain('RESCHEDULED');
  });

  it('exports the assessment sheet exactly as transcribed', () => {
    expect(interviews.BEHAVIOURAL_CRITERIA.map((c) => c.key)).toEqual([
      'openness', 'conscientiousness', 'extraversion', 'agreeableness', 'emotional_stability',
    ]);
    expect(interviews.TECHNICAL_CRITERIA.map((c) => c.key)).toEqual([
      'technical_knowledge', 'relevant_experience', 'problem_solving',
      'tools_software', 'planning_organizing',
    ]);
    expect(interviews.CRITICAL_FLAGS).toHaveLength(3);
    expect(interviews.DECISIONS).toEqual(
      ['PROCEED', 'PROCEED_WITH_CONDITIONS', 'HOLD', 'CV_POOL', 'REJECT'],
    );
    // Thresholds printed on the sheet.
    expect(interviews.FIT_BANDS.map((b) => b.min)).toEqual([4.2, 3.5, 3.0, 0]);
    expect(interviews.SCORE_GUIDE[5]).toBe('Excellent');
  });

  it('does not leak the aggregate class', () => {
    expect((interviews as Record<string, unknown>)['Interview']).toBeUndefined();
  });
});

describe('Offer module public surface', () => {
  it('exports the service, permissions and status vocabulary', () => {
    expect(typeof offers.OfferService).toBe('function');
    expect(offers.OFFER_PERMISSIONS.APPROVE_DIRECTOR).toBe('offer.approve_director');
    expect(offers.OFFER_STATUSES).toContain('EXPIRED');
    expect(offers.OFFER_STATUSES).toContain('REJECTED_BY_APPROVER');
  });

  it('exports every error the HTTP layer maps', () => {
    for (const name of [
      'OfferDomainError', 'IllegalOfferTransitionError', 'CompensationLockedError',
      'UnknownComponentError', 'OfferSelfApprovalError', 'OfferReasonRequiredError',
      'LiveOfferExistsError',
    ]) {
      expect(typeof offers[name as keyof typeof offers], name).toBe('function');
    }
  });

  it('does not leak the aggregate class', () => {
    expect((offers as Record<string, unknown>)['Offer']).toBeUndefined();
  });
});

describe('Assessment helpers', () => {
  it('reports completeness for the progress indicator', () => {
    expect(interviews.completeness('RECRUITER', { openness: 4 }))
      .toEqual({ scored: 1, total: 5 });
    expect(interviews.completeness('HIRING_MANAGER', {}))
      .toEqual({ scored: 0, total: 5 });
  });

  it('excludes N/A from the average rather than scoring it zero', () => {
    expect(interviews.averageScore({ a: 4, b: 'NA' })).toBe(4);
    expect(interviews.averageScore({ a: 'NA' })).toBeNull();
    expect(interviews.averageScore({})).toBeNull();
  });

  it('maps averages onto the sheet’s fit bands', () => {
    expect(interviews.fitBandFor(4.5)).toBe('STRONG');
    expect(interviews.fitBandFor(4.2)).toBe('STRONG');
    expect(interviews.fitBandFor(3.9)).toBe('ACCEPTABLE');
    expect(interviews.fitBandFor(3.2)).toBe('BORDERLINE');
    expect(interviews.fitBandFor(2.0)).toBe('WEAK');
    expect(interviews.fitBandFor(null)).toBeNull();
  });

  it('detects a raised critical flag', () => {
    expect(interviews.hasAnyCriticalFlag({ blaming: false })).toBe(false);
    expect(interviews.hasAnyCriticalFlag({ blaming: true })).toBe(true);
  });

  it('routes each evaluator role to its own section', () => {
    expect(interviews.criteriaFor('RECRUITER')).toBe(interviews.BEHAVIOURAL_CRITERIA);
    expect(interviews.criteriaFor('HIRING_MANAGER')).toBe(interviews.TECHNICAL_CRITERIA);
  });
});
