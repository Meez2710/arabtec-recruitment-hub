// TEST SUPPORT ONLY — builders for the integration tests.
//
// These construct aggregates through their real constructors, never by hand-
// writing rows. A fixture that INSERTs SQL directly would let the tests pass
// against data the domain could never have produced, which is precisely the
// failure mode repository tests exist to catch.

import { AuthContext } from '../../../modules/shared/kernel/auth-context.js';
import { Requisition } from '../../../modules/hiring/domain/requisition.js';
import { Application } from '../../../modules/hiring/domain/application.js';
import { Interview } from '../../../modules/interview/domain/interview.js';
import { Offer } from '../../../modules/offer/domain/offer.js';
import type { Actor } from '../../../modules/shared/kernel/domain.js';

export const globalCtx = (over: Partial<{ tenantId: number; userId: number }> = {}): AuthContext =>
  new AuthContext({
    tenantId: over.tenantId ?? 1,
    userId: over.userId ?? 7,
    userName: 'Mona Adel',
    permissions: [],
    projectScopes: [],
    isGlobalScope: true,
  });

/** A context that can see only the listed projects. Scope tests depend on this. */
export const scopedCtx = (projectIds: readonly number[], tenantId = 1): AuthContext =>
  new AuthContext({
    tenantId,
    userId: 9,
    userName: 'Scoped User',
    permissions: [],
    projectScopes: [...projectIds],
    isGlobalScope: false,
  });

export const actorOf = (ctx: AuthContext): Actor => ctx.actor;

export const aRequisition = (input: {
  id: number;
  ticketNo: string;
  ctx: AuthContext;
  projectId?: number;
  headcount?: number;
}): Requisition => Requisition.create({
  id: input.id,
  tenantId: input.ctx.tenantId,
  ticketNo: input.ticketNo,
  title: 'Site Engineer',
  projectId: input.projectId ?? 3,
  departmentId: 4,
  requesterId: 7,
  headcount: input.headcount ?? 2,
  createdBy: input.ctx.userId,
});

/**
 * DRAFT -> APPROVED -> OPEN, the state most operations require.
 *
 * `submit({approvalRequired:false})` lands directly on APPROVED, and assigning a
 * recruiter from APPROVED is what opens a requisition — there is no `open()`
 * method. Reproducing the real path here rather than forcing state keeps the
 * fixtures honest.
 */
export const anOpenRequisition = (input: {
  id: number;
  ticketNo: string;
  ctx: AuthContext;
  projectId?: number;
  headcount?: number;
}): Requisition => {
  const r = aRequisition(input);
  r.submit(input.ctx.actor, { approvalRequired: false });
  r.assignRecruiter(input.ctx.userId, input.ctx.actor);
  return r;
};

export const anApplication = (input: {
  id: number;
  applicationNo: string;
  candidateId: number;
  requisitionId: number;
  ctx: AuthContext;
}): Application => Application.create({
  id: input.id,
  tenantId: input.ctx.tenantId,
  applicationNo: input.applicationNo,
  candidateId: input.candidateId,
  requisitionId: input.requisitionId,
  recruiterId: input.ctx.userId,
  stage: 'SOURCED',
  actor: input.ctx.actor,
});

export const anInterview = (input: {
  id: number;
  interviewNo: string;
  applicationId: number;
  candidateId: number;
  requisitionId: number;
  ctx: AuthContext;
  startsAt?: Date;
  round?: number;
}): Interview => Interview.schedule({
  id: input.id,
  tenantId: input.ctx.tenantId,
  interviewNo: input.interviewNo,
  applicationId: input.applicationId,
  candidateId: input.candidateId,
  requisitionId: input.requisitionId,
  round: input.round ?? 1,
  mode: 'ONSITE',
  startsAt: input.startsAt ?? new Date('2026-04-01T09:00:00.000Z'),
  durationMinutes: 60,
  locationOrLink: 'Meeting Room 2',
  panel: [
    { userId: 11, role: 'RECRUITER', isLead: true },
    { userId: 12, role: 'HIRING_MANAGER', isLead: false },
  ],
  actor: input.ctx.actor,
  now: new Date('2026-03-01T09:00:00.000Z'),
});

export const anOffer = (input: {
  id: number;
  offerNo: string;
  applicationId: number;
  candidateId: number;
  requisitionId: number;
  ctx: AuthContext;
  lines?: readonly { componentCode: string; amount: number }[];
}): Offer => Offer.draft({
  id: input.id,
  tenantId: input.ctx.tenantId,
  offerNo: input.offerNo,
  applicationId: input.applicationId,
  candidateId: input.candidateId,
  requisitionId: input.requisitionId,
  positionTitle: 'Site Engineer',
  currency: 'EGP',
  lines: input.lines ?? [
    { componentCode: 'BASIC_SALARY', amount: 12_500.5 },
    { componentCode: 'TRANSPORTATION', amount: 1_250.25 },
  ],
  joiningDate: new Date('2026-05-01T00:00:00.000Z'),
  knownComponents: ['BASIC_SALARY', 'ACCOMMODATION', 'TRANSPORTATION', 'OTHERS', 'AREA_ALLOWANCE'],
  actor: input.ctx.actor,
});
