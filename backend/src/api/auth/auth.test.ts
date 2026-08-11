// Auth unit tests — the fail-closed behaviour, without a database.
//
// These matter more than their size suggests: every one of them is a case where
// getting it wrong fails OPEN, and an open failure in identity is a data breach
// rather than a bug report.

import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { JwtTokenVerifier } from './authenticate.js';
import { LegacyPrincipalResolver } from './legacy-principal-resolver.js';
import { StaticPrincipalResolver, toAuthContext } from './principal.js';
import type { Principal } from './principal.js';

const SECRET = 'unit-test-secret';

describe('JwtTokenVerifier', () => {
  const verifier = new JwtTokenVerifier(SECRET);

  it('accepts a token it signed', () => {
    expect(verifier.verify(jwt.sign({ sub: 42 }, SECRET))).toBe(42);
  });

  it('accepts a string subject, as the legacy issuer emits', () => {
    expect(verifier.verify(jwt.sign({ sub: '42' }, SECRET))).toBe(42);
  });

  it('returns null for every kind of bad token, without distinguishing them', () => {
    for (const token of [
      'not-a-token',
      jwt.sign({ sub: 42 }, 'other-secret'),
      jwt.sign({ sub: 42 }, SECRET, { expiresIn: '-1s' }),
      jwt.sign({ sub: 'abc' }, SECRET),
      jwt.sign({ sub: -1 }, SECRET),
      jwt.sign({ sub: 1.5 }, SECRET),
      jwt.sign({ noSubject: true }, SECRET),
    ]) {
      expect(verifier.verify(token)).toBeNull();
    }
  });

  it('refuses to start in production without a secret', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['JWT_SECRET'];
    try {
      // A guessable default in production is how an entire system gets
      // impersonated. Failing to boot is the correct outcome.
      expect(() => new JwtTokenVerifier()).toThrow(/JWT_SECRET is required/);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });
});

describe('LegacyPrincipalResolver', () => {
  const resolverFor = (row: unknown): LegacyPrincipalResolver =>
    new LegacyPrincipalResolver(1, () => row as never);

  it('maps a well-formed legacy user', async () => {
    const principal = await resolverFor({
      id: 7, fullName: 'Mona Adel', status: 'active',
      permissions: ['requisition.create'], roles: ['recruiter'],
      scopes: [{ scope_type: 'project', project_id: 3 }],
      mustChangePassword: false,
    }).resolve(7);

    expect(principal).toMatchObject({
      userId: 7, userName: 'Mona Adel', status: 'active',
      permissions: ['requisition.create'], projectScopes: [3], isGlobalScope: false,
    });
  });

  it('returns null when the user is gone', async () => {
    expect(await resolverFor(null).resolve(7)).toBeNull();
    expect(await resolverFor(undefined).resolve(7)).toBeNull();
  });

  it('fails CLOSED on an unreadable permission list', async () => {
    const principal = await resolverFor({ id: 7, permissions: 'admin', status: 'active' }).resolve(7);
    // Not "everything" and not a crash — nothing.
    expect(principal?.permissions).toEqual([]);
  });

  it('treats a missing status as inactive, not active', async () => {
    expect((await resolverFor({ id: 7 }).resolve(7))?.status).toBe('inactive');
  });

  it('grants global scope only to a named role', async () => {
    const scoped = await resolverFor({ id: 7, roles: ['recruiter'], scopes: [], status: 'active' }).resolve(7);
    // No scopes must mean "sees nothing". The opposite default is how a scoping
    // bug becomes a data breach.
    expect(scoped?.isGlobalScope).toBe(false);
    expect(scoped?.projectScopes).toEqual([]);

    const director = await resolverFor({ id: 8, roles: ['hr_director'], status: 'active' }).resolve(8);
    expect(director?.isGlobalScope).toBe(true);
  });

  it('ignores scope rows that are not projects', async () => {
    const principal = await resolverFor({
      id: 7, status: 'active',
      scopes: [
        { scope_type: 'project', project_id: 3 },
        { scope_type: 'department', scope_id: 99 },
        { scope_type: 'project', project_id: 3 },
        'garbage',
      ],
    }).resolve(7);
    // Deduplicated, and an unrecognised scope type never widens access.
    expect(principal?.projectScopes).toEqual([3]);
  });
});

describe('toAuthContext', () => {
  it('carries identity, permissions and scope onto the domain context', () => {
    const principal: Principal = {
      userId: 7, userName: 'Mona', permissions: ['a', 'b'],
      projectScopes: [3, 4], isGlobalScope: false, tenantId: 2,
      mustChangePassword: false, status: 'active',
    };
    const ctx = toAuthContext(principal);

    expect(ctx.has('a')).toBe(true);
    expect(ctx.has('c')).toBe(false);
    expect(ctx.canAccessProject(3)).toBe(true);
    expect(ctx.canAccessProject(9)).toBe(false);
    expect(ctx.actor).toEqual({ id: 7, name: 'Mona' });
    expect(ctx.tenantId).toBe(2);
  });
});

describe('StaticPrincipalResolver', () => {
  it('resolves known ids and refuses unknown ones', async () => {
    const principal: Principal = {
      userId: 1, userName: 'X', permissions: [], projectScopes: [],
      isGlobalScope: true, tenantId: 1, mustChangePassword: false, status: 'active',
    };
    const resolver = new StaticPrincipalResolver(new Map([[1, principal]]));
    expect(await resolver.resolve(1)).toBe(principal);
    expect(await resolver.resolve(2)).toBeNull();
  });
});
