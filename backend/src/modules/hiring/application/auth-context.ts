// Permission codes owned by the Hiring context.
//
// AuthContext itself moved to the shared kernel in Phase 2.5 — it is a concept
// every context needs and none of them owns. Re-exported here so existing
// imports keep working.

export { AuthContext } from '../../shared/kernel/auth-context.js';
export type { AuthContextProps } from '../../shared/kernel/auth-context.js';

export const HIRING_PERMISSIONS = {
  /** Record a candidate as hired against a requisition. */
  RECORD_HIRE: 'hiring.record',
  /**
   * Reverse a hire. Deliberately narrow and separate from requisition.edit —
   * it is the one operation that gives back headcount after the fact.
   */
  REVERSE_HIRE: 'hiring.reverse',
  VIEW_ALL: 'requisition.view_all',
  VIEW_OWN: 'requisition.view_own',
} as const;
