// TEST SUPPORT ONLY — never imported by production code.

import type { AuthContext } from '../../../hiring/index.js';
import { Interview, type InterviewProps } from '../../domain/interview.js';
import type {
  InterviewRepository, InterviewTransactionScope, InterviewUnitOfWork,
} from '../ports.js';
import type {
  BusySlot, CalendarEventHandle, CalendarProvider, TimeSlot,
} from '../../../shared/ports/notifications.js';

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryInterviewStore {
  rows = new Map<number, InterviewProps>();
  private idSeq = 0;
  private noSeq = 0;

  put(interview: Interview): void {
    this.rows.set(interview.id, clone(interview.toState()));
  }

  get(id: number): Interview | null {
    const row = this.rows.get(id);
    return row ? Interview.fromState(revive(clone(row))) : null;
  }

  nextId(): number { this.idSeq += 1; return this.idSeq; }
  nextNo(): string { this.noSeq += 1; return `IV-${String(this.noSeq).padStart(5, '0')}`; }

  snapshot(): string { return JSON.stringify([...this.rows]); }
  restore(snap: string): void {
    this.rows = new Map((JSON.parse(snap) as [number, InterviewProps][]).map(
      ([k, v]) => [k, revive(v)],
    ));
  }
}

function revive(p: InterviewProps): InterviewProps {
  p.startsAt = new Date(p.startsAt);
  if (p.lastRescheduledAt) p.lastRescheduledAt = new Date(p.lastRescheduledAt);
  for (const a of p.assessments) {
    (a as { submittedAt: Date }).submittedAt = new Date(a.submittedAt);
  }
  return p;
}

export class InMemoryInterviewRepository implements InterviewRepository {
  constructor(private readonly store: InMemoryInterviewStore) {}

  async findById(id: number, ctx: AuthContext): Promise<Interview | null> {
    const iv = this.store.get(id);
    return iv && iv.tenantId === ctx.tenantId ? iv : null;
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Interview | null> {
    return this.findById(id, ctx);
  }

  async save(interview: Interview): Promise<void> { this.store.put(interview); }
  async nextInterviewNo(): Promise<string> { return this.store.nextNo(); }
  async nextId(): Promise<number> { return this.store.nextId(); }

  async findBookedFor(
    userIds: readonly number[], window: { startsAt: Date; endsAt: Date }, ctx: AuthContext,
  ): Promise<readonly Interview[]> {
    const out: Interview[] = [];
    for (const [id] of this.store.rows) {
      const iv = await this.findById(id, ctx);
      if (!iv || !iv.isUpcoming) continue;
      const overlaps = iv.startsAt < window.endsAt && iv.startsAt >= window.startsAt;
      if (overlaps && iv.panel.some((p) => userIds.includes(p.userId))) out.push(iv);
    }
    return out;
  }

  async countForApplication(applicationId: number, ctx: AuthContext): Promise<number> {
    let n = 0;
    for (const [id] of this.store.rows) {
      const iv = await this.findById(id, ctx);
      if (iv && iv.applicationId === applicationId) n += 1;
    }
    return n;
  }
}

export class InMemoryInterviewUnitOfWork implements InterviewUnitOfWork {
  readonly interviews: InMemoryInterviewRepository;
  failCommit = false;

  constructor(private readonly store: InMemoryInterviewStore) {
    this.interviews = new InMemoryInterviewRepository(store);
  }

  async transaction<T>(fn: (tx: InterviewTransactionScope) => Promise<T>): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      const result = await fn({ interviews: this.interviews });
      if (this.failCommit) throw new Error('commit failed');
      return result;
    } catch (err) {
      this.store.restore(snapshot);
      throw err;
    }
  }
}

/** Records calls so tests can assert the calendar was invoked — or was not. */
export class FakeCalendarProvider implements CalendarProvider {
  readonly id = 'fake';
  created = 0;
  cancelled: string[] = [];
  shouldFail = false;

  async getFreeBusy(): Promise<readonly BusySlot[]> { return []; }

  async createEvent(): Promise<CalendarEventHandle> {
    if (this.shouldFail) throw new Error('calendar unavailable');
    this.created += 1;
    return { externalEventId: `ext-${this.created}`, icsContent: 'BEGIN:VCALENDAR' };
  }

  async updateEvent(externalEventId: string): Promise<CalendarEventHandle> {
    return { externalEventId };
  }

  async cancelEvent(externalEventId: string): Promise<void> {
    this.cancelled.push(externalEventId);
  }
}

export const oneHour = (from: Date): TimeSlot => ({
  startsAt: from, endsAt: new Date(from.getTime() + 3_600_000),
});
