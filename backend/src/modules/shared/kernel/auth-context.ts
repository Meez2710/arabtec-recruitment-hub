// AuthContext — identity, permissions and data scope for a single operation.
//
// Every repository method in every context takes one. That is what makes scoping
// a property of the query rather than something each route has to remember, and
// it is the injection point multi-tenancy will use later (ADR-0005).
//
// `siteScopes` is deliberately absent: the Site entity was retired from the
// requisition model, so project scope is the only spatial dimension.

import type { Actor } from './domain.js';

export interface AuthContextProps {
  readonly tenantId: number;
  readonly userId: number;
  readonly userName: string;
  readonly permissions: readonly string[];
  readonly projectScopes: readonly number[];
  readonly isGlobalScope: boolean;
}

export class AuthContext {
  readonly tenantId: number;
  readonly userId: number;
  readonly userName: string;
  readonly projectScopes: readonly number[];
  readonly isGlobalScope: boolean;
  private readonly perms: ReadonlySet<string>;

  constructor(props: AuthContextProps) {
    this.tenantId = props.tenantId;
    this.userId = props.userId;
    this.userName = props.userName;
    this.projectScopes = [...props.projectScopes];
    this.isGlobalScope = props.isGlobalScope;
    this.perms = new Set(props.permissions);
  }

  has(permission: string): boolean {
    return this.perms.has(permission);
  }

  hasAny(...permissions: string[]): boolean {
    return permissions.some((p) => this.perms.has(p));
  }

  hasAll(...permissions: string[]): boolean {
    return permissions.every((p) => this.perms.has(p));
  }

  /**
   * Whether this context may see data belonging to `projectId`.
   *
   * Repositories translate this into a WHERE fragment. It is exposed here as
   * well so services can fail fast, but a service check is never a substitute
   * for the query-level filter — an out-of-scope row must be unreachable, not
   * merely un-requested.
   */
  canAccessProject(projectId: number | null): boolean {
    if (this.isGlobalScope) return true;
    if (projectId === null) return false;
    return this.projectScopes.includes(projectId);
  }

  /** The actor identity domain aggregates record in history and events. */
  get actor(): Actor {
    return { id: this.userId, name: this.userName };
  }

  /** A system context for background jobs. Carries no permissions by default. */
  static system(tenantId: number, opts: { permissions?: readonly string[] } = {}): AuthContext {
    return new AuthContext({
      tenantId,
      userId: 0,
      userName: 'System',
      permissions: opts.permissions ?? [],
      projectScopes: [],
      isGlobalScope: true,
    });
  }
}
