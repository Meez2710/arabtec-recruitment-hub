// TEST SUPPORT ONLY — never imported by production code.
//
// Minimal in-memory implementations of the ports, existing solely so the
// application services can be exercised without a database (Phase 1 rule 2).
// They are deliberately thin: no query language, no indexes, no persistence.
//
// The one behaviour they model faithfully is ROLLBACK. `transaction()` snapshots
// the store and restores it on throw, so "a rejected operation leaves no partial
// state" is a claim the tests actually verify rather than assume.

import { Application, type ApplicationProps } from '../../domain/application.js';
import { Requisition, type RequisitionProps, type DomainEvent } from '../../domain/requisition.js';
import type { AuthContext } from '../../../shared/kernel/auth-context.js';
import type { ApplicationRepository, RequisitionRepository } from '../ports/repositories.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { EventBus } from '../../../shared/kernel/ports.js';
import type { OfferGateway } from '../ports/offer-gateway.js';

interface Row<T> {
  readonly tenantId: number;
  readonly projectId: number | null;
  readonly props: T;
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryStore {
  requisitions = new Map<number, Row<RequisitionProps>>();
  applications = new Map<number, Row<ApplicationProps>>();
  private ticketSeq = 0;
  private appSeq = 0;
  private idSeq = 0;

  putRequisition(r: Requisition, projectId: number | null = 1): void {
    this.requisitions.set(r.id, { tenantId: r.tenantId, projectId, props: clone(r.toState()) });
  }

  putApplication(a: Application, projectId: number | null = 1): void {
    this.applications.set(a.id, { tenantId: a.tenantId, projectId, props: clone(a.toState()) });
  }

  requisition(id: number): Requisition | null {
    const row = this.requisitions.get(id);
    return row ? Requisition.fromState(clone(row.props)) : null;
  }

  application(id: number): Application | null {
    const row = this.applications.get(id);
    return row ? Application.fromState(clone(row.props)) : null;
  }

  nextTicketNo(): string {
    this.ticketSeq += 1;
    return `REQ-2026-${String(this.ticketSeq).padStart(5, '0')}`;
  }

  nextApplicationNo(): string {
    this.appSeq += 1;
    return `APP-${String(this.appSeq).padStart(5, '0')}`;
  }

  nextId(): number {
    this.idSeq += 1;
    return this.idSeq;
  }

  snapshot(): string {
    return JSON.stringify({
      requisitions: [...this.requisitions],
      applications: [...this.applications],
    });
  }

  restore(snap: string): void {
    const parsed = JSON.parse(snap) as {
      requisitions: [number, Row<RequisitionProps>][];
      applications: [number, Row<ApplicationProps>][];
    };
    this.requisitions = new Map(parsed.requisitions);
    this.applications = new Map(parsed.applications);
    // JSON round-trips Dates to strings; revive the fields the aggregates read.
    for (const [, row] of this.applications) reviveApplicationDates(row.props);
    for (const [, row] of this.requisitions) reviveRequisitionDates(row.props);
  }
}

function reviveApplicationDates(p: ApplicationProps): void {
  p.lastActivityAt = new Date(p.lastActivityAt);
  if (p.nextActionDueAt) p.nextActionDueAt = new Date(p.nextActionDueAt);
  for (const h of p.history) h.movedAt = new Date(h.movedAt);
}

function reviveRequisitionDates(p: RequisitionProps): void {
  for (const s of p.seats) if (s.filledAt) s.filledAt = new Date(s.filledAt);
}

/** Models the scope predicate a real repository puts in its WHERE clause. */
function inScope<T>(row: Row<T> | undefined, ctx: AuthContext): row is Row<T> {
  if (!row) return false;
  if (row.tenantId !== ctx.tenantId) return false;
  return ctx.canAccessProject(row.projectId);
}

export class InMemoryRequisitionRepository implements RequisitionRepository {
  constructor(private readonly store: InMemoryStore) {}

  async findById(id: number, ctx: AuthContext): Promise<Requisition | null> {
    const row = this.store.requisitions.get(id);
    return inScope(row, ctx) ? Requisition.fromState(clone(row.props)) : null;
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Requisition | null> {
    return this.findById(id, ctx);
  }

  async save(requisition: Requisition): Promise<void> {
    const existing = this.store.requisitions.get(requisition.id);
    this.store.requisitions.set(requisition.id, {
      tenantId: requisition.tenantId,
      projectId: existing?.projectId ?? null,
      props: clone(requisition.toState()),
    });
  }

  async nextTicketNo(): Promise<string> {
    return this.store.nextTicketNo();
  }

  async nextId(): Promise<number> {
    return this.store.nextId();
  }
}

export class InMemoryApplicationRepository implements ApplicationRepository {
  constructor(private readonly store: InMemoryStore) {}

  async findById(id: number, ctx: AuthContext): Promise<Application | null> {
    const row = this.store.applications.get(id);
    return inScope(row, ctx) ? Application.fromState(clone(row.props)) : null;
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Application | null> {
    return this.findById(id, ctx);
  }

  async save(application: Application): Promise<void> {
    const existing = this.store.applications.get(application.id);
    this.store.applications.set(application.id, {
      tenantId: application.tenantId,
      projectId: existing?.projectId ?? null,
      props: clone(application.toState()),
    });
  }

  async nextApplicationNo(): Promise<string> {
    return this.store.nextApplicationNo();
  }

  async nextId(): Promise<number> {
    return this.store.nextId();
  }

  async findActiveHireForCandidate(
    candidateId: number,
    ctx: AuthContext,
    opts: { excludeApplicationId?: number } = {},
  ): Promise<number | null> {
    for (const [id, row] of this.store.applications) {
      if (!inScope(row, ctx)) continue;
      if (id === opts.excludeApplicationId) continue;
      if (row.props.candidateId !== candidateId) continue;
      if (row.props.stage === 'HIRED') return id;
    }
    return null;
  }

  async findNonTerminalByRequisition(
    requisitionId: number,
    ctx: AuthContext,
  ): Promise<Application[]> {
    const terminal = new Set(['HIRED', 'REJECTED', 'WITHDRAWN', 'OFFER_DECLINED']);
    const out: Application[] = [];
    for (const [, row] of this.store.applications) {
      if (!inScope(row, ctx)) continue;
      if (row.props.requisitionId !== requisitionId) continue;
      if (terminal.has(row.props.stage)) continue;
      out.push(Application.fromState(clone(row.props)));
    }
    return out;
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  readonly requisitions: InMemoryRequisitionRepository;
  readonly applications: InMemoryApplicationRepository;
  /** Set to fail the commit, to prove events are not published on failure. */
  failCommit = false;

  constructor(private readonly store: InMemoryStore) {
    this.requisitions = new InMemoryRequisitionRepository(store);
    this.applications = new InMemoryApplicationRepository(store);
  }

  async transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      const result = await fn({
        requisitions: this.requisitions,
        applications: this.applications,
      });
      if (this.failCommit) throw new Error('commit failed');
      return result;
    } catch (err) {
      this.store.restore(snapshot);
      throw err;
    }
  }
}

export class RecordingEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  calls = 0;

  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.calls += 1;
    this.published.push(...events);
  }

  typesOf(): string[] {
    return this.published.map((e) => e.type);
  }

  reset(): void {
    this.published.length = 0;
    this.calls = 0;
  }
}

/** Stub until the Offer module exists. Returns no live offers by default. */
export class StubOfferGateway implements OfferGateway {
  constructor(private readonly live: readonly number[] = []) {}
  async applicationsWithLiveOffers(): Promise<readonly number[]> {
    return this.live;
  }
}
