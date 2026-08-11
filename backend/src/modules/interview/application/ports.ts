// Ports for the Interview context. Interfaces only.

import type { AuthContext } from '../../shared/kernel/auth-context.js';
import type { Interview } from '../domain/interview.js';

export interface InterviewRepository {
  findById(id: number, ctx: AuthContext): Promise<Interview | null>;
  findByIdForUpdate(id: number, ctx: AuthContext): Promise<Interview | null>;
  save(interview: Interview): Promise<void>;
  nextInterviewNo(ctx: AuthContext): Promise<string>;
  nextId(ctx: AuthContext): Promise<number>;

  /** Interviews already booked for these users in a window — conflict detection. */
  findBookedFor(
    userIds: readonly number[],
    window: { startsAt: Date; endsAt: Date },
    ctx: AuthContext,
  ): Promise<readonly Interview[]>;

  /** Rounds already held for an application, so the next round number is derived. */
  countForApplication(applicationId: number, ctx: AuthContext): Promise<number>;
}

export interface InterviewTransactionScope {
  readonly interviews: InterviewRepository;
}

export interface InterviewUnitOfWork {
  transaction<T>(fn: (tx: InterviewTransactionScope) => Promise<T>): Promise<T>;
}

