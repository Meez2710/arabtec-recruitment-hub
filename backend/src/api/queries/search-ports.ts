// Smart search port. Drizzle-free.

import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';

export interface SearchHit {
  readonly entityType: 'Candidate' | 'Requisition';
  readonly id: number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly reference: string;
  readonly status: string;
  /** Relevance, higher is better. Comparable only WITHIN one entity type. */
  readonly rank: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface SearchResults {
  readonly query: string;
  /** Terms actually searched, after optional skill normalisation. */
  readonly terms: readonly string[];
  readonly candidates: readonly SearchHit[];
  readonly requisitions: readonly SearchHit[];
  readonly totals: { readonly candidates: number; readonly requisitions: number };
}

export interface SearchFilters {
  readonly types?: readonly ('Candidate' | 'Requisition')[];
  readonly limitPerType?: number;
}

export interface SearchReadModel {
  search(query: string, f: SearchFilters, ctx: AuthContext): Promise<SearchResults>;
}
