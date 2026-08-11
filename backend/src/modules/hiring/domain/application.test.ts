import { describe, expect, it } from 'vitest';
import { Application } from './application.js';
import type { Actor } from './requisition.js';
import {
  IllegalTransitionError,
  InvalidEntryStageError,
  MissingReasonError,
} from './errors.js';
import { ALL_STAGES, TRANSITIONS, type ApplicationStage } from './stages.js';

const RECRUITER: Actor = { id: 30, name: 'Recruiter' };

function app(stage: 'SOURCED' | 'MATCHED' = 'SOURCED'): Application {
  return Application.create({
    id: 1,
    tenantId: 1,
    applicationNo: 'APP-00001',
    candidateId: 42,
    requisitionId: 7,
    recruiterId: RECRUITER.id,
    stage,
    actor: RECRUITER,
  });
}

/** Walk an application forward through the pipeline using legal moves only. */
function advanceTo(target: ApplicationStage): Application {
  const a = app();
  const path: Array<[ApplicationStage, 'MANUAL' | 'SYSTEM']> = [
    ['MATCHED', 'MANUAL'],
    ['INTERVIEWING', 'MANUAL'],
    ['OFFER_PREPARATION', 'MANUAL'],
    ['OFFER_SENT', 'SYSTEM'],
    ['HIRED', 'SYSTEM'],
  ];
  for (const [stage, trigger] of path) {
    a.transitionTo(stage, RECRUITER, { trigger });
    if (stage === target) break;
  }
  return a;
}

describe('Application — creation (BL-03)', () => {
  it('creates at an entry stage', () => {
    expect(app('SOURCED').stage).toBe('SOURCED');
    expect(app('MATCHED').stage).toBe('MATCHED');
  });

  it.each(['HIRED', 'OFFER_SENT', 'REJECTED', 'INTERVIEWING', 'OFFER_PREPARATION'])(
    'refuses to create directly at %s',
    (stage) => {
      expect(() =>
        Application.create({
          id: 1, tenantId: 1, applicationNo: 'APP-1', candidateId: 42,
          requisitionId: 7, recruiterId: null, stage, actor: RECRUITER,
        }),
      ).toThrow(InvalidEntryStageError);
    },
  );

  it('records the opening history entry', () => {
    const a = app();
    expect(a.history).toHaveLength(1);
    expect(a.history[0]).toMatchObject({ fromStage: null, toStage: 'SOURCED' });
  });
});

describe('Application — the transition map', () => {
  it('permits the full forward pipeline', () => {
    const a = advanceTo('HIRED');
    expect(a.stage).toBe('HIRED');
    expect(a.isHired).toBe(true);
  });

  it('permits backward moves where the business allows them', () => {
    const a = advanceTo('INTERVIEWING');
    a.transitionTo('MATCHED', RECRUITER);
    expect(a.stage).toBe('MATCHED');
  });

  it('refuses a skipped stage', () => {
    const a = app();
    expect(() => a.transitionTo('OFFER_PREPARATION', RECRUITER)).toThrow(IllegalTransitionError);
  });

  it('refuses to move out of every terminal stage', () => {
    const terminals: Array<[ApplicationStage, () => Application]> = [
      ['HIRED', () => advanceTo('HIRED')],
      ['REJECTED', () => { const a = app(); a.transitionTo('REJECTED', RECRUITER, { reason: 'no' }); return a; }],
      ['WITHDRAWN', () => { const a = app(); a.transitionTo('WITHDRAWN', RECRUITER, { reason: 'left' }); return a; }],
    ];
    for (const [stage, make] of terminals) {
      const a = make();
      expect(a.stage).toBe(stage);
      expect(a.isTerminal).toBe(true);
      expect(() => a.transitionTo('MATCHED', RECRUITER)).toThrow(IllegalTransitionError);
    }
  });
});

describe('Application — system-only stages (BL-14)', () => {
  it('refuses a manual move to OFFER_SENT', () => {
    const a = advanceTo('OFFER_PREPARATION');
    expect(() => a.transitionTo('OFFER_SENT', RECRUITER, { trigger: 'MANUAL' }))
      .toThrow(IllegalTransitionError);
  });

  it('refuses a manual move to HIRED', () => {
    const a = advanceTo('OFFER_SENT');
    expect(() => a.transitionTo('HIRED', RECRUITER, { trigger: 'MANUAL' }))
      .toThrow(IllegalTransitionError);
  });

  it('allows the offer module to drive them', () => {
    const a = advanceTo('OFFER_PREPARATION');
    a.transitionTo('OFFER_SENT', RECRUITER, { trigger: 'SYSTEM' });
    a.transitionTo('HIRED', RECRUITER, { trigger: 'SYSTEM' });
    expect(a.stage).toBe('HIRED');
  });
});

describe('Application — reason requirements', () => {
  it.each([
    ['REJECTED', 'rejectionReason'],
    ['NOT_SUITABLE', 'notSuitableReason'],
    ['WITHDRAWN', 'withdrawalReason'],
    ['ON_HOLD', 'onHoldReason'],
  ] as const)('requires a reason for %s', (stage, field) => {
    const a = app();
    expect(() => a.transitionTo(stage, RECRUITER)).toThrow(MissingReasonError);
    expect(() => a.transitionTo(stage, RECRUITER, { reason: '   ' })).toThrow(MissingReasonError);

    a.transitionTo(stage, RECRUITER, { reason: 'documented reason' });
    expect(a.stage).toBe(stage);
    expect(a.reason(field)).toBe('documented reason');
  });

  it('does not demand a reason for ordinary forward moves', () => {
    const a = app();
    expect(() => a.transitionTo('MATCHED', RECRUITER)).not.toThrow();
  });
});

describe('Application — hold and resume', () => {
  it('restores the stage the hold interrupted', () => {
    const a = advanceTo('INTERVIEWING');
    a.transitionTo('ON_HOLD', RECRUITER, { reason: 'candidate travelling' });
    expect(a.stage).toBe('ON_HOLD');
    a.resume(RECRUITER);
    expect(a.stage).toBe('INTERVIEWING');
  });

  it('refuses resume when not on hold', () => {
    expect(() => app().resume(RECRUITER)).toThrow(IllegalTransitionError);
  });
});

describe('Application — reverse hire (BL-23 pair)', () => {
  it('moves a hired application back to OFFER_SENT with a reason', () => {
    const a = advanceTo('HIRED');
    a.reverseHire(RECRUITER, 'candidate did not start');
    expect(a.stage).toBe('OFFER_SENT');
    expect(a.isHired).toBe(false);
  });

  it('refuses to reverse an application that was never hired', () => {
    expect(() => app().reverseHire(RECRUITER, 'x')).toThrow(IllegalTransitionError);
  });

  it('requires a reason', () => {
    const a = advanceTo('HIRED');
    expect(() => a.reverseHire(RECRUITER, '  ')).toThrow(MissingReasonError);
  });
});

describe('Application — history, versioning and events', () => {
  it('appends one history entry per move and bumps the version', () => {
    const a = app();
    const v0 = a.version;
    a.transitionTo('MATCHED', RECRUITER);
    a.transitionTo('INTERVIEWING', RECRUITER);
    expect(a.history).toHaveLength(3); // create + 2 moves
    expect(a.version).toBe(v0 + 2);
  });

  it('emits ApplicationStageChanged carrying the irreversible flag', () => {
    const a = app();
    a.pullEvents();
    a.transitionTo('REJECTED', RECRUITER, { reason: 'not a fit' });
    const [event] = a.pullEvents().filter((e) => e.type === 'ApplicationStageChanged');
    expect(event?.payload).toMatchObject({ to: 'REJECTED', isIrreversible: true });
  });

  it('round-trips through toState/fromState', () => {
    const a = advanceTo('INTERVIEWING');
    const revived = Application.fromState(a.toState());
    expect(revived.stage).toBe('INTERVIEWING');
    expect(revived.history).toHaveLength(a.history.length);
  });
});

describe('Application — recruiter workspace fields', () => {
  it('sets and clears the next action', () => {
    const a = app();
    const due = new Date('2026-09-01T09:00:00Z');
    a.setNextAction('Schedule technical interview', due, RECRUITER);
    expect(a.toState().nextAction).toBe('Schedule technical interview');
    expect(a.toState().nextActionDueAt).toEqual(due);

    a.setNextAction(null, null, RECRUITER);
    expect(a.toState().nextAction).toBeNull();
  });

  it('reassigns the recruiter and bumps the version', () => {
    const a = app();
    const before = a.version;
    a.assignRecruiter(77, RECRUITER);
    expect(a.toState().recruiterId).toBe(77);
    expect(a.version).toBe(before + 1);
  });

  it('exposes tenant and candidate identity for scoped reads', () => {
    const a = app();
    expect(a.tenantId).toBe(1);
    expect(a.candidateId).toBe(42);
    expect(a.requisitionId).toBe(7);
    expect(a.id).toBe(1);
    expect(a.reason('rejectionReason')).toBeNull();
  });
});

describe('Transition map integrity', () => {
  it('declares every stage', () => {
    for (const stage of ALL_STAGES) {
      expect(TRANSITIONS.has(stage)).toBe(true);
    }
  });

  it('never targets an unknown stage', () => {
    for (const [, list] of TRANSITIONS) {
      for (const t of list) {
        expect(ALL_STAGES).toContain(t.to);
      }
    }
  });

  it('has no self-transitions', () => {
    for (const [from, list] of TRANSITIONS) {
      expect(list.some((t) => t.to === from)).toBe(false);
    }
  });

  it('leaves every terminal stage with no outbound edges', () => {
    for (const stage of ['HIRED', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED'] as const) {
      expect(TRANSITIONS.get(stage)).toHaveLength(0);
    }
  });
});
