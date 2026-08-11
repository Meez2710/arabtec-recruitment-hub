// Anti-corruption layer over the Offer context (ADR-0007).
//
// Hiring needs one fact about offers and must not read their tables to get it.
// The Offer module implements this; until then a stub returning empty satisfies it.

import type { AuthContext } from '../../../shared/kernel/auth-context.js';

export interface OfferGateway {
  /**
   * Applications holding a sent-but-unresolved offer. A live offer blocks
   * closing the requisition (Document 2 §5).
   */
  applicationsWithLiveOffers(requisitionId: number, ctx: AuthContext): Promise<readonly number[]>;
}
