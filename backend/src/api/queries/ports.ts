// Read-side ports (CQRS read model).
//
// Reads DO NOT go through aggregates. An aggregate exists to protect invariants
// on write; loading fifty of them to render a list is pure cost — fifty
// invariant re-checks, fifty child-collection queries, and a shape the UI has to
// unpick anyway. So the read side projects rows straight to DTOs.
//
// What it still obeys: scope. Every query takes an AuthContext and applies the
// same predicate the repositories use, inside the SQL. A read model is not a
// hole in the security boundary.
//
// Interfaces live here, free of Drizzle, so controllers depend on them without
// reaching the driver.

import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
  readonly sort?: string;
  readonly direction?: 'asc' | 'desc';
}

/* ------------------------------ requisitions ------------------------------ */

export interface RequisitionListItem {
  readonly id: number;
  readonly ticketNo: string;
  readonly title: string;
  readonly projectId: number;
  readonly departmentId: number;
  readonly requesterId: number;
  readonly recruiterId: number | null;
  readonly state: string;
  readonly headcount: number;
  readonly filledSeats: number;
  readonly openSeats: number;
  readonly applicationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface RequisitionFilters {
  readonly state?: readonly string[];
  readonly projectId?: number;
  readonly departmentId?: number;
  readonly recruiterId?: number;
  readonly requesterId?: number;
  /** Free text over ticket number and title. */
  readonly q?: string;
  /** Only requisitions with at least one unfilled seat. */
  readonly hasOpenSeats?: boolean;
}

export interface RequisitionDetail extends RequisitionListItem {
  readonly previousState: string | null;
  readonly closeReason: string | null;
  readonly createdBy: number;
  readonly seats: readonly {
    readonly seatNo: number;
    readonly state: string;
    readonly applicationId: number | null;
    readonly filledAt: Date | null;
    readonly cancelReason: string | null;
  }[];
}

/* ------------------------------ applications ------------------------------ */

export interface ApplicationListItem {
  readonly id: number;
  readonly applicationNo: string;
  readonly candidateId: number;
  readonly requisitionId: number;
  readonly requisitionTicketNo: string;
  readonly requisitionTitle: string;
  readonly recruiterId: number | null;
  readonly stage: string;
  readonly previousStage: string | null;
  readonly nextAction: string | null;
  readonly nextActionDueAt: Date | null;
  readonly lastActivityAt: Date;
  readonly createdAt: Date;
  readonly version: number;
}

export interface ApplicationFilters {
  readonly requisitionId?: number;
  readonly candidateId?: number;
  readonly stage?: readonly string[];
  readonly recruiterId?: number;
  readonly q?: string;
  /** Open next-actions due at or before this instant — the My Work list. */
  readonly dueBefore?: Date;
  /** No activity since this instant — the stalled list. */
  readonly inactiveSince?: Date;
  /** Exclude HIRED/REJECTED/WITHDRAWN/OFFER_DECLINED. */
  readonly liveOnly?: boolean;
}

export interface ApplicationDetail extends ApplicationListItem {
  readonly reasons: Record<string, string>;
  readonly history: readonly {
    readonly fromStage: string | null;
    readonly toStage: string;
    readonly reason: string | null;
    readonly trigger: string;
    readonly actorId: number | null;
    readonly actorName: string | null;
    readonly movedAt: Date;
  }[];
}

/* ------------------------------- interviews ------------------------------- */

export interface InterviewListItem {
  readonly id: number;
  readonly interviewNo: string;
  readonly applicationId: number;
  readonly candidateId: number;
  readonly requisitionId: number;
  readonly round: number;
  readonly mode: string;
  readonly startsAt: Date;
  readonly durationMinutes: number;
  readonly locationOrLink: string | null;
  readonly status: string;
  readonly rescheduleCount: number;
  readonly organiserUserId: number;
  readonly panelUserIds: readonly number[];
  readonly assessmentCount: number;
  readonly version: number;
}

export interface InterviewFilters {
  readonly status?: readonly string[];
  readonly applicationId?: number;
  readonly candidateId?: number;
  readonly requisitionId?: number;
  /** Interviews this user sits on. Drives "my interviews". */
  readonly panellistId?: number;
  readonly from?: Date;
  readonly to?: Date;
}

export interface InterviewDetail extends InterviewListItem {
  readonly cancelReason: string | null;
  readonly externalEventId: string | null;
  readonly panel: readonly {
    readonly userId: number; readonly role: string; readonly isLead: boolean;
  }[];
  readonly assessments: readonly {
    readonly evaluatorUserId: number;
    readonly evaluatorName: string;
    readonly evaluatorRole: string;
    readonly scores: Record<string, number | 'NA'>;
    readonly criticalFlags: Record<string, boolean>;
    readonly justification: string;
    readonly submittedAt: Date;
  }[];
}

/* --------------------------------- offers --------------------------------- */

export interface OfferListItem {
  readonly id: number;
  readonly offerNo: string;
  readonly applicationId: number;
  readonly candidateId: number;
  readonly requisitionId: number;
  readonly positionTitle: string;
  readonly currency: string;
  readonly status: string;
  readonly totalNet: number;
  readonly joiningDate: Date | null;
  readonly sentAt: Date | null;
  readonly expiresAt: Date | null;
  readonly preparedBy: number;
  readonly approvedBy: number | null;
  readonly requiresDirectorApproval: boolean;
  readonly version: number;
}

export interface OfferFilters {
  readonly status?: readonly string[];
  readonly applicationId?: number;
  readonly candidateId?: number;
  readonly requisitionId?: number;
  /** SENT offers whose validity elapses before this instant. */
  readonly expiringBefore?: Date;
  readonly preparedBy?: number;
  readonly awaitingApproval?: boolean;
}

export interface OfferDetail extends OfferListItem {
  readonly decidedAt: Date | null;
  readonly reason: string | null;
  readonly templateCode: string | null;
  readonly templateVersion: number | null;
  readonly lines: readonly { readonly componentCode: string; readonly amount: number }[];
}

/* -------------------------------- timeline -------------------------------- */

export interface TimelineItem {
  readonly id: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly eventType: string;
  readonly actorId: number | null;
  readonly actorName: string | null;
  readonly occurredAt: Date;
  readonly previousValue: Record<string, unknown>;
  readonly newValue: Record<string, unknown>;
  readonly correlationId: string | null;
}

export interface TimelineFilters {
  readonly entityType?: string;
  readonly entityId?: number;
  readonly actorId?: number;
  readonly eventType?: readonly string[];
  readonly from?: Date;
  readonly to?: Date;
}

/* -------------------------------- dashboard ------------------------------- */

export interface DashboardSummary {
  readonly requisitions: {
    readonly byState: Readonly<Record<string, number>>;
    readonly openSeats: number;
    readonly filledSeats: number;
  };
  readonly applications: {
    readonly byStage: Readonly<Record<string, number>>;
    readonly live: number;
  };
  readonly interviews: {
    readonly upcoming: number;
    readonly awaitingFeedback: number;
  };
  readonly offers: {
    readonly byStatus: Readonly<Record<string, number>>;
    readonly expiringSoon: number;
  };
  /** Everything scoped to the CALLING user. The "My Work" panel. */
  readonly myWork: {
    readonly dueToday: number;
    readonly overdue: number;
    readonly stalled: number;
    readonly myRequisitions: number;
    readonly myUpcomingInterviews: number;
    readonly offersAwaitingMyApproval: number;
  };
}

/* --------------------------------- the port -------------------------------- */

export interface ReadModel {
  requisitions(f: RequisitionFilters, p: PageRequest, ctx: AuthContext):
    Promise<Page<RequisitionListItem>>;
  requisition(id: number, ctx: AuthContext): Promise<RequisitionDetail | null>;

  applications(f: ApplicationFilters, p: PageRequest, ctx: AuthContext):
    Promise<Page<ApplicationListItem>>;
  application(id: number, ctx: AuthContext): Promise<ApplicationDetail | null>;

  interviews(f: InterviewFilters, p: PageRequest, ctx: AuthContext):
    Promise<Page<InterviewListItem>>;
  interview(id: number, ctx: AuthContext): Promise<InterviewDetail | null>;

  offers(f: OfferFilters, p: PageRequest, ctx: AuthContext): Promise<Page<OfferListItem>>;
  offer(id: number, ctx: AuthContext): Promise<OfferDetail | null>;

  timeline(f: TimelineFilters, p: PageRequest, ctx: AuthContext): Promise<Page<TimelineItem>>;

  dashboard(ctx: AuthContext, now: Date): Promise<DashboardSummary>;
}
