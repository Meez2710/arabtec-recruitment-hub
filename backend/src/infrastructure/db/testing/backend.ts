// TEST SUPPORT ONLY — which database the suite runs against, and whether it is
// safe to destroy.
//
// ⚠️ THE SAFETY CHECK BELOW IS NOT CEREMONY.
//
// The real-PostgreSQL harness runs `DROP SCHEMA public CASCADE` so migrations
// always apply to a clean database — that is the only way to verify migration
// ORDER rather than just migration content. This project's production database
// is a live ATS holding real candidates' personal data. A stray `DATABASE_URL`
// in a shell would otherwise delete it.
//
// So: the target must LOOK like a test database, or carry an explicit override.
// Refusing to run is always the correct failure mode here.

export type BackendKind = 'pglite' | 'postgres';

export interface BackendChoice {
  readonly kind: BackendKind;
  readonly connectionString?: string;
  /** Shown when real PostgreSQL is unavailable, so a skip is never mysterious. */
  readonly reason: string;
}

/** Names that mark a database as disposable. Anything else needs the override. */
const TEST_NAME_PATTERN = /(^|[_-])(test|tests|testing|ci|scratch)([_-]|$)/i;

const databaseNameOf = (connectionString: string): string => {
  try {
    const url = new URL(connectionString);
    return decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
};

export class UnsafeTestDatabaseError extends Error {
  constructor(name: string) {
    super(
      `Refusing to run destructive tests against database "${name}".\n` +
      'The harness drops and recreates the public schema.\n' +
      'Point TEST_DATABASE_URL at a database whose name contains "test" or "ci", ' +
      'or set ALLOW_DESTRUCTIVE_TESTS=1 if you are certain.',
    );
    this.name = 'UnsafeTestDatabaseError';
  }
}

/**
 * Decide the backend from the environment.
 *
 * `TEST_DATABASE_URL` wins over `DATABASE_URL`: a developer with a normal
 * `DATABASE_URL` pointing at their working database should not have it wiped by
 * running the test suite.
 */
export const resolveBackend = (env: NodeJS.ProcessEnv = process.env): BackendChoice => {
  const connectionString = env['TEST_DATABASE_URL'] ?? env['DATABASE_URL'];

  if (connectionString === undefined || connectionString.trim() === '') {
    return {
      kind: 'pglite',
      reason:
        'No TEST_DATABASE_URL or DATABASE_URL set — using PGlite (real PostgreSQL in WASM, ' +
        'single-connection). Tests needing genuinely concurrent sessions will skip.',
    };
  }

  const name = databaseNameOf(connectionString);
  const overridden = env['ALLOW_DESTRUCTIVE_TESTS'] === '1';
  if (!overridden && !TEST_NAME_PATTERN.test(name)) {
    throw new UnsafeTestDatabaseError(name === '' ? '(unparseable)' : name);
  }

  return {
    kind: 'postgres',
    connectionString,
    reason: `Using PostgreSQL at database "${name}".`,
  };
};

/**
 * Whether genuinely concurrent sessions are available.
 *
 * PGlite is single-connection: two transactions cannot be in flight at once, so
 * lock CONTENTION is unobservable. Tests that need it guard on this and skip
 * with the reason above rather than silently asserting something weaker.
 */
export const supportsConcurrentSessions = (choice: BackendChoice): boolean =>
  choice.kind === 'postgres';
