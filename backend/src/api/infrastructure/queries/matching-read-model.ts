// Matching read model.
//
// One query for the whole page, joined to the candidate: a list of suggestions
// without names is unusable, and fetching each candidate separately is the N+1
// this read layer exists to avoid.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { candidate, candidateMatch } from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { executorFor } from '../../../infrastructure/db/current-transaction.js';
import { scopedViaRequisition } from '../../../infrastructure/db/scope.js';
import { toNumber } from '../../../infrastructure/db/numeric.js';
import type { AuthContext } from '../../../modules/shared/kernel/auth-context.js';
import type { Page, PageRequest } from '../../queries/ports.js';
import type { MatchFilters, MatchView, MatchingReadModel } from '../../queries/matching-ports.js';

export class DrizzleMatchingReadModel implements MatchingReadModel {
  constructor(private readonly root: Executor) {}

  private get db(): Executor { return executorFor(this.root); }

  async matchesFor(
    requisitionId: number, f: MatchFilters, p: PageRequest, ctx: AuthContext,
  ): Promise<Page<MatchView>> {
    const where: SQL[] = [
      eq(candidateMatch.requisitionId, requisitionId),
      // A suggestion is ABOUT a requisition, so it inherits that requisition's
      // project scope. Tenant alone would let a project-scoped recruiter read
      // the shortlist for work they cannot see.
      scopedViaRequisition(
        this.db, candidateMatch.tenantId, candidateMatch.requisitionId, ctx,
      ),
    ];
    // Default to SUGGESTED: the list is a work queue, and dismissed items
    // reappearing by default is what makes people stop using one.
    const statuses = f.status?.length ? [...f.status] : ['SUGGESTED'];
    where.push(inArray(candidateMatch.status, statuses as never));
    if (f.minScore !== undefined) {
      where.push(sql`${candidateMatch.score} >= ${f.minScore.toFixed(3)}`);
    }

    const rows = await this.db
      .select({
        id: candidateMatch.id,
        candidateId: candidateMatch.candidateId,
        candidateNo: candidate.candidateNo,
        fullName: candidate.fullName,
        currentPosition: candidate.currentPosition,
        candidateState: candidate.state,
        score: candidateMatch.score,
        evidence: candidateMatch.evidence,
        missingRequirements: candidateMatch.missingRequirements,
        source: candidateMatch.source,
        generation: candidateMatch.generation,
        status: candidateMatch.status,
        applicationId: candidateMatch.applicationId,
        reason: candidateMatch.reason,
        version: candidateMatch.version,
        total: sql<number>`count(*) over()`.mapWith(Number),
      })
      .from(candidateMatch)
      .innerJoin(candidate, eq(candidate.id, candidateMatch.candidateId))
      .where(and(...where))
      .orderBy(desc(candidateMatch.score), asc(candidateMatch.id))
      .limit(p.limit)
      .offset(p.offset);

    return {
      items: rows.map(({ total: _t, score, evidence, missingRequirements, generation, ...rest }) => ({
        ...rest,
        // numeric arrives as a string; a text score sorts "0.9" below "0.10".
        score: toNumber(score),
        evidence: (Array.isArray(evidence) ? evidence : []) as MatchView['evidence'],
        missingRequirements: (Array.isArray(missingRequirements) ? missingRequirements : []) as string[],
        generation: (generation ?? null) as Record<string, unknown> | null,
      })),
      total: rows[0]?.total ?? 0,
      limit: p.limit,
      offset: p.offset,
    };
  }
}
