// Smart search.
//
// Full-text FIRST, trigram as a fallback:
//
//   `websearch_to_tsquery` handles what people actually type — quoted phrases,
//   `-exclusions`, plain words — and ranks by relevance. But tsquery matches
//   whole lexemes, so "prima" finds nothing. When full-text returns nothing, a
//   substring pass catches the partial word.
//
// The fallback is ILIKE rather than trigram similarity: `pg_trgm` is not
// available on every backend this runs against, and a search feature that only
// works on some deployments is worse than a slightly slower one that always
// does. Adding the extension later accelerates this without a query change.
//
// Both run against the same maintained `search_text`, so a search for a skill
// finds people whose skill list contains it — something no ILIKE over `name`
// could ever do.
//
// Every query is SCOPED: candidates by tenant, requisitions by project.

import { and, eq, ilike, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { candidate, hiringRequisition } from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import { executorFor } from '../../../infrastructure/db/current-transaction.js';
import { scopedByProjectColumn } from '../../../infrastructure/db/scope.js';
import type { AuthContext } from '../../../modules/shared/kernel/auth-context.js';
import type { AICapabilities } from '../../../modules/shared/kernel/ai/index.js';
import { isProposal } from '../../../modules/shared/kernel/ai/index.js';
import type {
  SearchFilters, SearchHit, SearchReadModel, SearchResults,
} from '../../queries/search-ports.js';

export interface SearchOptions {
  /**
   * OPTIONAL. When a `SkillNormalizer` is configured, a search for "autocad"
   * also matches records recorded as "AutoCAD 2019". Without one, search works
   * exactly as it does now — the feature degrades to plain text matching.
   */
  readonly capabilities?: AICapabilities;
}

/** Escape LIKE wildcards so a query of "100%" is a literal, not a match-all. */
const likePattern = (value: string): string =>
  `%${value.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

export class DrizzleSearchReadModel implements SearchReadModel {
  constructor(
    private readonly root: Executor,
    private readonly opts: SearchOptions = {},
  ) {}

  private get db(): Executor { return executorFor(this.root); }

  async search(
    query: string, f: SearchFilters, ctx: AuthContext,
  ): Promise<SearchResults> {
    const trimmed = query.trim();
    if (trimmed === '') {
      return {
        query, terms: [], candidates: [], requisitions: [],
        totals: { candidates: 0, requisitions: 0 },
      };
    }

    const terms = await this.expand(trimmed);
    const limit = f.limitPerType ?? 10;
    const types = f.types ?? ['Candidate', 'Requisition'];
    // One tsquery over the original phrase plus any normalised aliases, so an
    // expansion widens the search rather than replacing it.
    const tsquery = terms.map((t) => `(${t})`).join(' or ');

    const [candidates, requisitions] = await Promise.all([
      types.includes('Candidate') ? this.searchCandidates(trimmed, tsquery, limit, ctx) : [],
      types.includes('Requisition') ? this.searchRequisitions(trimmed, tsquery, limit, ctx) : [],
    ]);

    return {
      query,
      terms,
      candidates,
      requisitions,
      totals: { candidates: candidates.length, requisitions: requisitions.length },
    };
  }

  /** Ask the normaliser for aliases. Absent or abstaining -> the original term. */
  private async expand(query: string): Promise<readonly string[]> {
    const normalizer = this.opts.capabilities?.skillNormalizer;
    if (normalizer === undefined) return [query];
    try {
      const outcome = await normalizer.normalize([query]);
      if (!isProposal(outcome)) return [query];
      const aliases = outcome.content
        .flatMap((n) => [n.canonical, ...n.aliases])
        .filter((v) => typeof v === 'string' && v.trim() !== '');
      return [...new Set([query, ...aliases])];
    } catch {
      // Search must never fail because an optional enrichment did.
      return [query];
    }
  }

  private async searchCandidates(
    raw: string, tsquery: string, limit: number, ctx: AuthContext,
  ): Promise<readonly SearchHit[]> {
    const scope: SQL[] = [
      eq(candidate.tenantId, ctx.tenantId),
      // An erased record is redacted; surfacing it in search would leak that it
      // ever existed.
      ne(candidate.state, 'ERASED'),
    ];

    const columns = {
      id: candidate.id,
      title: candidate.fullName,
      subtitle: candidate.currentPosition,
      reference: candidate.candidateNo,
      status: candidate.state,
      company: candidate.currentCompany,
      location: candidate.location,
      skills: candidate.skills,
    };

    const full = await this.db
      .select({
        ...columns,
        rank: sql<number>`ts_rank(
          to_tsvector('simple', "candidate"."search_text"),
          websearch_to_tsquery('simple', ${tsquery})
        )`.mapWith(Number),
      })
      .from(candidate)
      .where(and(
        ...scope,
        sql`to_tsvector('simple', "candidate"."search_text")
            @@ websearch_to_tsquery('simple', ${tsquery})`,
      ))
      .orderBy(sql`2 desc`)
      .limit(limit);

    const rows = full.length > 0 ? full : await this.db
      .select({
        // Substring match, for the partial word full-text cannot reach. Rank is
        // a constant: there is no relevance signal here, and inventing one would
        // order results by nothing meaningful.
        ...columns,
        rank: sql<number>`0`.mapWith(Number),
      })
      .from(candidate)
      .where(and(...scope, ilike(candidate.searchText, likePattern(raw))))
      .orderBy(candidate.fullName)
      .limit(limit);

    return rows.map((r) => ({
      entityType: 'Candidate' as const,
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      reference: r.reference,
      status: r.status,
      rank: r.rank,
      extra: {
        currentCompany: r.company,
        location: r.location,
        skills: Array.isArray(r.skills) ? r.skills : [],
      },
    }));
  }

  private async searchRequisitions(
    raw: string, tsquery: string, limit: number, ctx: AuthContext,
  ): Promise<readonly SearchHit[]> {
    // Requisitions have no maintained blob — title and ticket number are the
    // whole searchable surface, so an expression over them is enough.
    const blob = sql`coalesce("hiring_requisition"."title", '') || ' '
      || coalesce("hiring_requisition"."ticket_no", '')`;

    const rows = await this.db
      .select({
        id: hiringRequisition.id,
        title: hiringRequisition.title,
        reference: hiringRequisition.ticketNo,
        status: hiringRequisition.state,
        headcount: hiringRequisition.headcount,
        projectId: hiringRequisition.projectId,
        rank: sql<number>`ts_rank(
          to_tsvector('simple', ${blob}), websearch_to_tsquery('simple', ${tsquery})
        )`.mapWith(Number),
      })
      .from(hiringRequisition)
      .where(and(
        scopedByProjectColumn(hiringRequisition.tenantId, hiringRequisition.projectId, ctx),
        sql`(to_tsvector('simple', ${blob}) @@ websearch_to_tsquery('simple', ${tsquery})
             or ${blob} ilike ${likePattern(raw)})`,
      ))
      .orderBy(sql`7 desc`)
      .limit(limit);

    return rows.map((r) => ({
      entityType: 'Requisition' as const,
      id: r.id,
      title: r.title,
      subtitle: null,
      reference: r.reference,
      status: r.status,
      rank: r.rank,
      extra: { headcount: r.headcount, projectId: r.projectId },
    }));
  }
}
