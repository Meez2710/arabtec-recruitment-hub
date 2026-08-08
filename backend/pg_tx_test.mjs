// PostgreSQL transaction affinity — REAL PostgreSQL only.
//
//   npm i --no-save embedded-postgres && node pg_tx_test.mjs
//
// WHY THIS CANNOT RUN ON SQLITE OR PGLITE
//
// The defect is that `pool.query()` acquires a connection per statement, so a
// transaction driven by repeated pool.query() calls spreads across connections.
// SQLite has one connection. PGlite has one connection. Neither can exhibit the
// bug, so neither can prove it fixed. Only a real Postgres with a real pool can.
//
// Skips cleanly (exit 0) when embedded-postgres is not installed, so it never
// breaks a normal checkout — but a skip is printed loudly and is NOT a pass.

import net from 'node:net';

let EmbeddedPostgres;
try {
  ({ default: EmbeddedPostgres } = await import('embedded-postgres'));
} catch {
  console.log('\n⊘ SKIPPED — embedded-postgres not installed.');
  console.log('  Real PostgreSQL is required; SQLite and PGlite cannot prove this.');
  console.log('  Run: npm i --no-save embedded-postgres\n');
  process.exit(0);
}

const PORT = 55433;
const DIR = `/tmp/arabtec_pgtx_${process.pid}`;
const USER = 'txtest';
const PASS = 'txtest';
const DB = 'txtest';

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

const free = (port) => new Promise((res) => {
  const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(port);
});
if (!(await free(PORT))) { console.error(`port ${PORT} is busy`); process.exit(2); }

console.log('\nStarting a disposable local PostgreSQL (not production, no real data)…');
const pgServer = new EmbeddedPostgres({
  databaseDir: DIR, user: USER, password: PASS, port: PORT, persistent: false,
});
await pgServer.initialise();
await pgServer.start();
await pgServer.createDatabase(DB);

// Point the app's own db.js at it. `?sslmode=disable` keeps sslFor() off.
process.env.DATABASE_URL = `postgres://${USER}:${PASS}@127.0.0.1:${PORT}/${DB}?sslmode=disable`;
process.env.PG_NO_SSL = 'true';
process.env.PG_TX_TIMEOUT_MS = '2500'; // short, so the abandoned-tx test is quick

const db = await import('./src/lib/db.js');
const { run, get, all, exec, tx, driverKind, inTransaction } = db;

const cleanup = async () => { try { await pgServer.stop(); } catch {} };
process.on('exit', () => { try { pgServer.stop(); } catch {} });

try {
  c('driver is postgres (not sqlite, not pglite)', driverKind() === 'postgres', driverKind());
  exec('CREATE TABLE t (id SERIAL PRIMARY KEY, v TEXT NOT NULL)');
  exec('CREATE TABLE conn_probe (id SERIAL PRIMARY KEY, phase TEXT, pid INT)');

  /* ------------------------------ 1. commit ----------------------------- */
  console.log('\n— 1. commit: multiple writes persist together —');
  tx(() => {
    run('INSERT INTO t (v) VALUES (?)', ['c1']);
    run('INSERT INTO t (v) VALUES (?)', ['c2']);
    run('INSERT INTO t (v) VALUES (?)', ['c3']);
  });
  c('all three rows persisted', get('SELECT count(*) AS n FROM t').n === 3, `n=${get('SELECT count(*) AS n FROM t').n}`);

  /* ----------------------------- 2. rollback ---------------------------- */
  console.log('\n— 2. rollback: injected failure persists nothing —');
  const before = get('SELECT count(*) AS n FROM t').n;
  let threw = false;
  try {
    tx(() => {
      run('INSERT INTO t (v) VALUES (?)', ['r1']);
      run('INSERT INTO t (v) VALUES (?)', ['r2']);
      throw new Error('injected failure after the writes');
    });
  } catch (e) { threw = /injected failure/.test(e.message); }
  c('the failure propagated to the caller', threw);
  c('no row from the failed transaction persisted',
    get('SELECT count(*) AS n FROM t').n === before, `${before} -> ${get('SELECT count(*) AS n FROM t').n}`);
  c('rolled-back values are absent', all("SELECT v FROM t WHERE v IN ('r1','r2')").length === 0);

  /* ------------------------- 3. connection affinity --------------------- */
  console.log('\n— 3. affinity: BEGIN, writes and COMMIT share one backend —');
  tx(() => {
    run('INSERT INTO conn_probe (phase, pid) VALUES (?, pg_backend_pid())', ['begin']);
    run('INSERT INTO conn_probe (phase, pid) VALUES (?, pg_backend_pid())', ['write']);
    run('INSERT INTO conn_probe (phase, pid) VALUES (?, pg_backend_pid())', ['commit']);
  });
  const pids = all('SELECT phase, pid FROM conn_probe ORDER BY id');
  const unique = new Set(pids.map((r) => r.pid));
  c('three statements recorded', pids.length === 3);
  c('all statements ran on ONE backend pid', unique.size === 1, `pids=${[...unique].join(',')}`);

  /* --------------------- 4. concurrency isolation ----------------------- */
  console.log('\n— 4. two overlapping transactions do not contaminate —');
  exec('DELETE FROM t');
  const P = db.__txPrimitivesForTest();
  c('raw transaction primitives available on postgres', P !== null);

  // BOTH open at the same time, on different connections, settled oppositely.
  const idA = P.begin();
  const idB = P.begin();
  c('two transactions got distinct ids', idA !== idB, `${idA} / ${idB}`);

  const pidA = P.get('SELECT pg_backend_pid() AS pid', [], idA).pid;
  const pidB = P.get('SELECT pg_backend_pid() AS pid', [], idB).pid;
  c('they hold DIFFERENT backend connections', pidA !== pidB, `${pidA} vs ${pidB}`);

  P.run('INSERT INTO t (v) VALUES ($1)', ['A-committed'], idA);
  P.run('INSERT INTO t (v) VALUES ($1)', ['B-rolled-back'], idB);

  // Neither may see the other's uncommitted row (READ COMMITTED).
  c('A cannot see B uncommitted row',
    P.get("SELECT count(*) AS n FROM t WHERE v='B-rolled-back'", [], idA).n === 0);
  c('B cannot see A uncommitted row',
    P.get("SELECT count(*) AS n FROM t WHERE v='A-committed'", [], idB).n === 0);
  c('an outside pooled read sees neither yet',
    get("SELECT count(*) AS n FROM t").n === 0);

  P.commit(idA);
  P.rollback(idB);

  c('A committed and survived', all("SELECT v FROM t WHERE v='A-committed'").length === 1);
  c("B rolled back and left nothing", all("SELECT v FROM t WHERE v='B-rolled-back'").length === 0);

  console.log('\n— 4b. settled ids are rejected, unknown ids are rejected —');
  let reuse = false;
  try { P.commit(idA); } catch (e) { reuse = /Unknown transaction/.test(e.message); }
  c('committing an already-settled transaction is refused', reuse);
  let unknown = false;
  try { P.rollback('tx-does-not-exist'); } catch (e) { unknown = /Unknown transaction/.test(e.message); }
  c('an unknown transaction id is refused', unknown);
  let afterSettle = false;
  try { P.run('INSERT INTO t (v) VALUES ($1)', ['zombie'], idB); }
  catch (e) { afterSettle = /Unknown transaction/.test(e.message); }
  c('a query after settle is refused, not silently pooled', afterSettle);
  c('and wrote nothing', all("SELECT v FROM t WHERE v='zombie'").length === 0);

  /* -------------------------- 5. pool pressure -------------------------- */
  console.log('\n— 5. more transactions than the pool size (max: 4) —');
  let poolOk = true;
  for (let i = 0; i < 12; i += 1) {
    try { tx(() => { run('INSERT INTO t (v) VALUES (?)', [`pool${i}`]); }); }
    catch (e) { poolOk = false; c(`transaction ${i} failed`, false, e.message); break; }
  }
  c('12 sequential transactions on a pool of 4 all completed', poolOk);
  c('every one committed', all("SELECT v FROM t WHERE v LIKE 'pool%'").length === 12);

  /* ------------------------ 6. no idle-in-transaction ------------------- */
  console.log('\n— 6. no connection left idle in transaction —');
  const idle = get(
    "SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = ?", [DB],
  ).n;
  c('no idle-in-transaction backends after commits and rollbacks', idle === 0, `n=${idle}`);

  /* --------------------------- 7. worker errors ------------------------- */
  console.log('\n— 7. failure paths release the client —');
  let sqlThrew = false;
  try { tx(() => { run('INSERT INTO t (v) VALUES (?)', ['x']); run('INSERT INTO nope (v) VALUES (?)', ['y']); }); }
  catch { sqlThrew = true; }
  c('a query failure inside a transaction propagates', sqlThrew);
  c('and rolls the whole thing back', all("SELECT v FROM t WHERE v='x'").length === 0);
  c('still no idle-in-transaction backend',
    get("SELECT count(*) AS n FROM pg_stat_activity WHERE state='idle in transaction' AND datname=?", [DB]).n === 0);
  c('the pool still works afterwards', get('SELECT 1 AS ok').ok === 1);

  console.log('\n— 7b. nesting, and use after settle —');
  exec('DELETE FROM t');
  tx(() => { run('INSERT INTO t (v) VALUES (?)', ['outer']); tx(() => { run('INSERT INTO t (v) VALUES (?)', ['inner']); }); });
  c('nested tx joins the outer one and both rows commit', all('SELECT v FROM t').length === 2);
  let nestedRolled = false;
  exec('DELETE FROM t');
  try { tx(() => { run('INSERT INTO t (v) VALUES (?)', ['o']); tx(() => { run('INSERT INTO t (v) VALUES (?)', ['i']); }); throw new Error('outer fails'); }); }
  catch { nestedRolled = true; }
  c('an outer failure rolls back the inner writes too', nestedRolled && all('SELECT v FROM t').length === 0);
  c('no transaction is left open on the process', inTransaction() === false);

  /* ------------------- 8. abandoned transaction timeout ----------------- */
  console.log('\n— 8. an abandoned transaction is reclaimed —');
  const orphanId = P.begin();
  P.run('INSERT INTO t (v) VALUES ($1)', ['orphan'], orphanId);
  c('orphan transaction is open and holding a connection',
    get("SELECT count(*) AS n FROM pg_stat_activity WHERE state='idle in transaction' AND datname=$1", [DB]).n >= 1);
  // Deliberately never settled. The worker must reclaim it.
  await new Promise((r) => setTimeout(r, 3400));
  c('reclaimed: no idle-in-transaction backend remains',
    get("SELECT count(*) AS n FROM pg_stat_activity WHERE state='idle in transaction' AND datname=$1", [DB]).n === 0);
  c('its uncommitted write was rolled back', all("SELECT v FROM t WHERE v='orphan'").length === 0);
  let orphanGone = false;
  try { P.commit(orphanId); } catch (e) { orphanGone = /Unknown transaction/.test(e.message); }
  c('the reclaimed id is no longer usable', orphanGone);

  console.log(`\n${fail === 0 ? '✓' : '✗'} PostgreSQL transactions: ${pass} passed, ${fail} failed\n`);
} catch (e) {
  console.error('\nFATAL:', e.message);
  fail += 1;
} finally {
  await cleanup();
}

process.exit(fail === 0 ? 0 : 1);
