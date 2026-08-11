// TEST SUPPORT ONLY — never imported by production code.

import type { AuthContext } from '../../../hiring/index.js';
import { Offer, type OfferProps } from '../../domain/offer.js';
import type {
  OfferRepository, OfferTransactionScope, OfferUnitOfWork,
} from '../offer-service.js';
import type { PipelineGateway } from '../../../hiring/index.js';

const clone = <T>(v: T): T => structuredClone(v);

function revive(p: OfferProps): OfferProps {
  if (p.joiningDate) p.joiningDate = new Date(p.joiningDate);
  if (p.sentAt) p.sentAt = new Date(p.sentAt);
  if (p.expiresAt) p.expiresAt = new Date(p.expiresAt);
  if (p.decidedAt) p.decidedAt = new Date(p.decidedAt);
  return p;
}

export class InMemoryOfferStore {
  rows = new Map<number, OfferProps>();
  private idSeq = 0;
  private noSeq = 0;

  put(offer: Offer): void { this.rows.set(offer.id, clone(offer.toState())); }

  get(id: number): Offer | null {
    const row = this.rows.get(id);
    return row ? Offer.fromState(revive(clone(row))) : null;
  }

  nextId(): number { this.idSeq += 1; return this.idSeq; }
  nextNo(): string { this.noSeq += 1; return `OFR-${String(this.noSeq).padStart(5, '0')}`; }

  snapshot(): string { return JSON.stringify([...this.rows]); }
  restore(snap: string): void {
    this.rows = new Map((JSON.parse(snap) as [number, OfferProps][]).map(([k, v]) => [k, revive(v)]));
  }
}

export class InMemoryOfferRepository implements OfferRepository {
  constructor(private readonly store: InMemoryOfferStore) {}

  async findById(id: number, ctx: AuthContext): Promise<Offer | null> {
    const o = this.store.get(id);
    return o && o.tenantId === ctx.tenantId ? o : null;
  }

  async findByIdForUpdate(id: number, ctx: AuthContext): Promise<Offer | null> {
    return this.findById(id, ctx);
  }

  async save(offer: Offer): Promise<void> { this.store.put(offer); }
  async nextOfferNo(): Promise<string> { return this.store.nextNo(); }
  async nextId(): Promise<number> { return this.store.nextId(); }

  async findExpirable(now: Date, ctx: AuthContext): Promise<readonly Offer[]> {
    const out: Offer[] = [];
    for (const [id] of this.store.rows) {
      const o = await this.findById(id, ctx);
      if (o && o.status === 'SENT' && o.expiresAt && o.expiresAt.getTime() <= now.getTime()) {
        out.push(o);
      }
    }
    return out;
  }

  async findLiveForApplication(applicationId: number, ctx: AuthContext): Promise<Offer | null> {
    for (const [id] of this.store.rows) {
      const o = await this.findById(id, ctx);
      if (o && o.applicationId === applicationId && o.isLive) return o;
    }
    return null;
  }
}

export class InMemoryOfferUnitOfWork implements OfferUnitOfWork {
  readonly offers: InMemoryOfferRepository;
  failCommit = false;

  constructor(private readonly store: InMemoryOfferStore) {
    this.offers = new InMemoryOfferRepository(store);
  }

  async transaction<T>(fn: (tx: OfferTransactionScope) => Promise<T>): Promise<T> {
    const snapshot = this.store.snapshot();
    try {
      const result = await fn({ offers: this.offers });
      if (this.failCommit) throw new Error('commit failed');
      return result;
    } catch (err) {
      this.store.restore(snapshot);
      throw err;
    }
  }
}

/** Records the stage moves the Offer context drives through the Hiring door. */
export class RecordingPipelineGateway implements PipelineGateway {
  readonly moves: Array<{ applicationId: number; toStage: string; reason?: string }> = [];

  async applySystemTransition(
    input: { applicationId: number; toStage: string; reason?: string },
  ): Promise<unknown> {
    this.moves.push(input);
    return { stage: input.toStage };
  }

  stages(): string[] { return this.moves.map((m) => m.toStage); }
}
