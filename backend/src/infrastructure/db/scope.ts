// Data scope as a SQL predicate.
//
// ADR-0005, rule 3: scope is applied INSIDE the query, never as a post-filter in
// JavaScript. A post-filter still reads the row, still logs the read, and still
// leaks existence through timing — and one forgotten `.filter()` is a silent
// cross-project data leak that no test notices.
//
// Rule 2 follows from rule 1: an out-of-scope row is indistinguishable from a
// row that does not exist. Both produce `null`. A caller must not be able to use
// 403-vs-404 as an existence oracle.

import { and, eq, exists, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import { hiringRequisition } from './schema/index.js';
import type { Executor } from './types.js';

/** Always-false. Used when a context has no global scope and no project scopes. */
const NEVER: SQL = sql`false`;

/**
 * Scope for a table that carries `project_id` directly — currently only
 * `hiring_requisition`.
 */
export const scopedByProjectColumn = (
  tenantColumn: PgColumn,
  projectColumn: PgColumn,
  ctx: AuthContext,
): SQL => {
  const tenant = eq(tenantColumn, ctx.tenantId);
  if (ctx.isGlobalScope) return tenant;
  if (ctx.projectScopes.length === 0) return NEVER;
  return and(tenant, inArray(projectColumn, [...ctx.projectScopes])) ?? NEVER;
};

/**
 * Scope for a table that reaches its project through `requisition_id`.
 *
 * `hiring_application`, `interview` and `offer` all carry `requisition_id` but
 * no `project_id`. Denormalising the project onto each of them would make a
 * requisition's project effectively immutable — or require a fan-out UPDATE that
 * could be interrupted. An EXISTS subquery costs one index probe on
 * `ix_requisition_tenant_project` instead.
 *
 * EXISTS rather than a JOIN specifically because these queries also run with
 * `FOR UPDATE`: PostgreSQL rejects a locking clause over an outer join and would
 * otherwise lock the joined requisition row too, widening contention far beyond
 * what the operation needs.
 */
export const scopedViaRequisition = (
  db: Executor,
  tenantColumn: PgColumn,
  requisitionColumn: PgColumn,
  ctx: AuthContext,
): SQL => {
  const tenant = eq(tenantColumn, ctx.tenantId);
  if (ctx.isGlobalScope) return tenant;
  if (ctx.projectScopes.length === 0) return NEVER;

  const reachable = exists(
    db
      .select({ one: sql`1` })
      .from(hiringRequisition)
      .where(
        and(
          eq(hiringRequisition.id, requisitionColumn),
          eq(hiringRequisition.tenantId, ctx.tenantId),
          inArray(hiringRequisition.projectId, [...ctx.projectScopes]),
        ),
      ),
  );
  return and(tenant, reachable) ?? NEVER;
};
