// Multi-process HTTP concurrency harness — TEST ONLY.
//
// WHY THIS HAS TO EXIST
//
// The database surface is synchronous: every statement blocks the main thread in
// Atomics.wait. That is what makes the transaction stack safe, but it also means
// a single Node process can never issue genuinely overlapping HTTP requests —
// whatever a test "sends concurrently" is serialised by the event loop it is
// sitting on. Race conditions between requests are therefore invisible to any
// same-process test, which is exactly the class of bug that matters for seats,
// application numbers and joined candidates.
//
// So: several INDEPENDENT backend processes, distinct PIDs, distinct ports, one
// shared real PostgreSQL. Overlap is then real OS-level concurrency and the
// database is the only thing arbitrating.
//
// This is a test fixture. It deliberately provides no production clustering,
// supervision or restart behaviour.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ----------------------------- safety guard ------------------------------- */

/**
 * Refuse anything that is not obviously a disposable test database.
 *
 * This harness truncates tables and spawns writers; pointing it at a real
 * database would be unrecoverable. The check is on the database NAME because
 * that is the part a human reads and mistypes. `ALLOW_DESTRUCTIVE_TESTS=1` is
 * the deliberate override, matching the convention already used elsewhere.
 */
const DISPOSABLE = /(^|[_-])(test|tests|testing|ci|scratch|tmp)([_-]|$)/i;

export function assertDisposable(dsn) {
  let name;
  try {
    name = new URL(dsn.replace(/^postgres(ql)?:/, 'http:')).pathname.replace(/^\//, '').split('?')[0];
  } catch {
    throw new Error('Concurrency harness: DSN is unparseable; refusing to run.');
  }
  if (!name) throw new Error('Concurrency harness: DSN names no database; refusing to run.');
  if (DISPOSABLE.test(name) || process.env.ALLOW_DESTRUCTIVE_TESTS === '1') return name;
  throw new Error(
    `Concurrency harness: refusing to run against database "${name}". `
    + 'It does not look disposable. Use a name containing test/ci/scratch, '
    + 'or set ALLOW_DESTRUCTIVE_TESTS=1 if you are certain.',
  );
}

/* ------------------------------- utilities -------------------------------- */

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const waitHealthy = async (port, pid, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // /api/health is LIVENESS — it answers as soon as the port is open. The
      // app then holds a separate readiness gate that 503s every /api call
      // until schema and seed finish (server.js:148-153). Waiting on liveness
      // alone produced 503s on the first real request, so wait for READINESS:
      // any non-503 answer from a real API route means the gate has opened.
      const live = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (live.ok) {
        const gated = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'readiness@probe.invalid', password: 'x' }),
        });
        if (gated.status !== 503) return true;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  // A child that never becomes healthy must FAIL the test, never skip it —
  // otherwise a broken build silently reports "no races found".
  throw new Error(`Backend process ${pid} on port ${port} never became healthy.`);
};

/* -------------------------------- cluster --------------------------------- */

/**
 * Start `processes` independent backends against one disposable PostgreSQL.
 *
 * @param {{processes?: number, dsn?: string, ownDatabase?: boolean, env?: object}} opts
 */
export async function startCluster(opts = {}) {
  const count = opts.processes ?? 2;
  let dsn = opts.dsn || process.env.PG_TEST_URL || '';
  let pgServer = null;
  let dataDir = null;

  if (!dsn) {
    // Local convenience only, and only when explicitly selected — never a
    // silent fallback that could mask a missing CI service.
    if (!opts.ownDatabase) {
      throw new Error(
        'Concurrency harness: no PG_TEST_URL. Set it, or pass { ownDatabase: true } '
        + 'to start a local disposable PostgreSQL.',
      );
    }
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const port = await freePort();
    dataDir = `/tmp/arabtec_cluster_${process.pid}_${port}`;
    pgServer = new EmbeddedPostgres({
      databaseDir: dataDir, user: 'txtest', password: 'txtest', port, persistent: false,
    });
    await pgServer.initialise();
    await pgServer.start();
    await pgServer.createDatabase('arabtec_test');
    dsn = `postgres://txtest:txtest@127.0.0.1:${port}/arabtec_test?sslmode=disable`;
  }

  const dbName = assertDisposable(dsn);

  // Seed ONCE in the parent, before any child starts, so the children share a
  // ready schema and cannot race each other creating it.
  process.env.DATABASE_URL = dsn;
  process.env.PG_NO_SSL = 'true';
  const { exec, get, all } = await import('../src/lib/db.js');
  for (const t of all(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'",
  )) exec(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`);
  await import('../prisma/seed.js');

  const children = [];
  for (let i = 0; i < count; i += 1) {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: dsn,
        PG_NO_SSL: 'true',
        PORT: String(port),
        NODE_ENV: 'test',
        JWT_SECRET: process.env.JWT_SECRET || 'harness-test-secret',
        SEED_DEMO_DATA: 'false',
        ...(opts.env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Diagnostics only: never echo request bodies or candidate data.
    const tail = [];
    const keep = (buf) => { tail.push(String(buf).slice(0, 400)); if (tail.length > 20) tail.shift(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    children.push({ index: i, port, proc: child, pid: child.pid, tail });
  }

  try {
    await Promise.all(children.map((c) => waitHealthy(c.port, c.pid)));
  } catch (e) {
    for (const c of children) { try { c.proc.kill('SIGKILL'); } catch { /* gone */ } }
    if (pgServer) { try { await pgServer.stop(); } catch { /* gone */ } }
    const diag = children.map((c) => `pid ${c.pid}: ${c.tail.slice(-3).join(' | ')}`).join('\n  ');
    throw new Error(`${e.message}\n  ${diag}`);
  }

  const base = (i) => `http://127.0.0.1:${children[i % children.length].port}`;

  const api = async (i, p, { method = 'GET', token, body } = {}) => {
    const r = await fetch(base(i) + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null; try { json = await r.json(); } catch { /* empty body */ }
    return { status: r.status, json, viaPid: children[i % children.length].pid };
  };

  const login = async (email, password = 'Arabtec@123') =>
    (await api(0, '/api/auth/login', { method: 'POST', body: { email, password } })).json?.token;

  /**
   * Fire requests that genuinely overlap.
   *
   * Each call is built lazily and they are released together, so the requests
   * are in flight at the same moment across different processes rather than
   * being interleaved by one event loop.
   */
  const race = (thunks) => Promise.allSettled(thunks.map((t) => t()));

  const idleInTransaction = () => get(
    "SELECT COUNT(*) c FROM pg_stat_activity WHERE state='idle in transaction' AND datname=$1",
    [dbName],
  ).c;

  const stop = async () => {
    for (const c of children) {
      try { c.proc.kill('SIGTERM'); } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 400));
    for (const c of children) {
      if (c.proc.exitCode === null && c.proc.signalCode === null) {
        try { c.proc.kill('SIGKILL'); } catch { /* gone */ }
      }
    }
    if (pgServer) { try { await pgServer.stop(); } catch { /* gone */ } }
    if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* gone */ } }
  };

  return {
    dsn, dbName, children, pids: children.map((c) => c.pid),
    ports: children.map((c) => c.port),
    api, login, race, stop, idleInTransaction,
    db: { get, all, exec },
  };
}
