// Identity, read from the legacy store (ADR-0009, strangler fig).
//
// There is no Identity bounded context yet. Users, roles, permissions and
// project scopes still live in the legacy SQLite layer, and blocking the API on
// extracting them would have delayed everything for no product gain.
//
// So this adapter reads the SAME `userContext()` the live system reads. An
// existing user keeps their session, their roles and their scopes, and the new
// API is immediately usable by the people already in the system. When Identity
// is extracted, ONLY this file changes — `PrincipalResolver` does not.
//
// The legacy module is JavaScript with no types, so everything crossing this
// boundary is validated rather than trusted. A missing field here would
// otherwise become an `undefined` permission set, which fails OPEN.

import type { Principal, PrincipalResolver } from './principal.js';

/** The shape `userContext()` returns. Validated, never assumed. */
interface LegacyUserContext {
  id?: unknown;
  fullName?: unknown;
  status?: unknown;
  permissions?: unknown;
  scopes?: unknown;
  roles?: unknown;
  mustChangePassword?: unknown;
}

type LegacyLoader = (userId: number) => LegacyUserContext | null | undefined;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Legacy scopes are rows, not plain ids. Pull out project ids and ignore
 * anything else — an unrecognised scope type must never widen access.
 */
const projectScopes = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const row of value) {
    if (typeof row === 'number' && Number.isInteger(row)) { ids.push(row); continue; }
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const type = record['scope_type'] ?? record['type'];
    if (type !== undefined && type !== 'project') continue;
    const id = record['project_id'] ?? record['projectId'] ?? record['scope_id'];
    if (typeof id === 'number' && Number.isInteger(id)) ids.push(id);
  }
  return [...new Set(ids)];
};

/** Roles that see everything. Global scope is a grant, never a default. */
const GLOBAL_ROLES = new Set(['system_admin', 'hr_director', 'admin']);

export class LegacyPrincipalResolver implements PrincipalResolver {
  private loader: LegacyLoader | null = null;

  constructor(
    private readonly tenantId = 1,
    /** Injectable so this is testable without the legacy SQLite database. */
    private readonly load?: LegacyLoader,
  ) {}

  private async loaderFn(): Promise<LegacyLoader> {
    if (this.load !== undefined) return this.load;
    if (this.loader === null) {
      // Dynamic import: the legacy module opens a SQLite handle on load, and
      // importing it eagerly would make every test that touches this file pay
      // for a database it does not use.
      // The legacy module is untyped JavaScript outside tsconfig's `include`,
      // so the specifier is built at runtime to keep TypeScript from trying to
      // resolve a declaration file that will never exist. The shape it returns
      // is validated below regardless.
      const specifier = '../../lib/models.js';
      const legacy = await import(/* @vite-ignore */ specifier) as { userContext?: LegacyLoader };
      if (typeof legacy.userContext !== 'function') {
        throw new Error('Legacy models.js does not export userContext()');
      }
      this.loader = legacy.userContext;
    }
    return this.loader;
  }

  async resolve(userId: number): Promise<Principal | null> {
    const load = await this.loaderFn();
    const raw = load(userId);
    if (raw === null || raw === undefined) return null;

    const id = typeof raw.id === 'number' ? raw.id : userId;
    const roles = stringList(raw.roles);
    const scopes = projectScopes(raw.scopes);

    return {
      userId: id,
      userName: typeof raw.fullName === 'string' ? raw.fullName : `User ${id}`,
      // Fails CLOSED: an unreadable permission list becomes no permissions,
      // never all of them.
      permissions: stringList(raw.permissions),
      projectScopes: scopes,
      // Global scope requires a named role. "No scopes recorded" must mean
      // "sees nothing", not "sees everything" — the opposite default is how a
      // scoping bug becomes a data breach.
      isGlobalScope: roles.some((r) => GLOBAL_ROLES.has(r)),
      tenantId: this.tenantId,
      mustChangePassword: raw.mustChangePassword === true,
      status: typeof raw.status === 'string' ? raw.status : 'inactive',
    };
  }
}
