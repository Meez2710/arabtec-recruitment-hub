// AuthContext is the carrier for identity, permissions and data scope. It is
// consulted by every service and every repository, so its behaviour is pinned
// here rather than only exercised indirectly through service tests.

import { describe, expect, it } from 'vitest';
import { AuthContext } from '../../shared/kernel/auth-context.js';
import { HIRING_PERMISSIONS } from './auth-context.js';

function ctx(overrides: Partial<ConstructorParameters<typeof AuthContext>[0]> = {}) {
  return new AuthContext({
    tenantId: 1,
    userId: 30,
    userName: 'Recruiter',
    permissions: ['requisition.view_all'],
    projectScopes: [1, 2],
    isGlobalScope: false,
    ...overrides,
  });
}

describe('AuthContext — permissions', () => {
  it('reports a held permission', () => {
    expect(ctx().has('requisition.view_all')).toBe(true);
    expect(ctx().has('hiring.record')).toBe(false);
  });

  it('hasAny is true when at least one is held', () => {
    const c = ctx({ permissions: ['a', 'b'] });
    expect(c.hasAny('b', 'z')).toBe(true);
    expect(c.hasAny('y', 'z')).toBe(false);
    expect(c.hasAny()).toBe(false);
  });

  it('hasAll requires every permission', () => {
    const c = ctx({ permissions: ['a', 'b'] });
    expect(c.hasAll('a', 'b')).toBe(true);
    expect(c.hasAll('a', 'z')).toBe(false);
    expect(c.hasAll()).toBe(true); // vacuously true
  });

  it('does not expose the permission set for mutation', () => {
    const perms = ['a'];
    const c = new AuthContext({
      tenantId: 1, userId: 1, userName: 'X',
      permissions: perms, projectScopes: [], isGlobalScope: true,
    });
    perms.push('b');
    expect(c.has('b')).toBe(false);
  });
});

describe('AuthContext — project scope', () => {
  it('permits only projects in scope', () => {
    const c = ctx();
    expect(c.canAccessProject(1)).toBe(true);
    expect(c.canAccessProject(2)).toBe(true);
    expect(c.canAccessProject(3)).toBe(false);
  });

  it('denies a null project when not global', () => {
    expect(ctx().canAccessProject(null)).toBe(false);
  });

  it('permits everything when global', () => {
    const c = ctx({ isGlobalScope: true, projectScopes: [] });
    expect(c.canAccessProject(999)).toBe(true);
    expect(c.canAccessProject(null)).toBe(true);
  });

  it('copies the scope array defensively', () => {
    const scopes = [1];
    const c = new AuthContext({
      tenantId: 1, userId: 1, userName: 'X',
      permissions: [], projectScopes: scopes, isGlobalScope: false,
    });
    scopes.push(2);
    expect(c.canAccessProject(2)).toBe(false);
  });
});

describe('AuthContext — actor projection', () => {
  it('projects the identity aggregates record in history and events', () => {
    expect(ctx().actor).toEqual({ id: 30, name: 'Recruiter' });
  });
});

describe('AuthContext.system', () => {
  it('is global but carries no permissions by default', () => {
    const sys = AuthContext.system(1);
    expect(sys.isGlobalScope).toBe(true);
    expect(sys.canAccessProject(999)).toBe(true);
    expect(sys.has(HIRING_PERMISSIONS.RECORD_HIRE)).toBe(false);
    expect(sys.actor).toEqual({ id: 0, name: 'System' });
  });

  it('grants only what a background job is explicitly given', () => {
    const sys = AuthContext.system(1, { permissions: [HIRING_PERMISSIONS.REVERSE_HIRE] });
    expect(sys.has(HIRING_PERMISSIONS.REVERSE_HIRE)).toBe(true);
    expect(sys.has(HIRING_PERMISSIONS.RECORD_HIRE)).toBe(false);
  });

  it('carries the tenant it was created for', () => {
    expect(AuthContext.system(7).tenantId).toBe(7);
  });
});
