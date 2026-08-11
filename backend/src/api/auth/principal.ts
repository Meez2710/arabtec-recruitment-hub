// Who is asking — the identity port.
//
// There is no Identity bounded context yet: users, roles, permissions and
// project scopes still live in the legacy SQLite layer. Rather than block the
// API on building one, this port names exactly what the API needs, and an
// adapter over the legacy `userContext()` satisfies it (ADR-0009, strangler
// fig). When Identity is extracted, only the adapter changes.
//
// The API therefore accepts the tokens the live system already issues, and an
// existing user keeps their session.

import { AuthContext } from '../../modules/shared/kernel/auth-context.js';

export interface Principal {
  readonly userId: number;
  readonly userName: string;
  readonly permissions: readonly string[];
  /** Project ids this user may see. Empty + not global means: nothing. */
  readonly projectScopes: readonly number[];
  readonly isGlobalScope: boolean;
  readonly tenantId: number;
  /** Blocks every request except password change. */
  readonly mustChangePassword: boolean;
  readonly status: string;
}

export interface PrincipalResolver {
  /** Null when the user does not exist or may not act. */
  resolve(userId: number): Promise<Principal | null>;
}

export const toAuthContext = (principal: Principal): AuthContext =>
  new AuthContext({
    tenantId: principal.tenantId,
    userId: principal.userId,
    userName: principal.userName,
    permissions: principal.permissions,
    projectScopes: principal.projectScopes,
    isGlobalScope: principal.isGlobalScope,
  });

/** Fixed principals, for tests and for the workers' system context. */
export class StaticPrincipalResolver implements PrincipalResolver {
  constructor(private readonly principals: ReadonlyMap<number, Principal>) {}

  async resolve(userId: number): Promise<Principal | null> {
    return this.principals.get(userId) ?? null;
  }
}
