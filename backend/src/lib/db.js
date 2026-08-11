// Database access layer for Arabtec Recruitment Hub.
//
// Tri-modal, identical SYNCHRONOUS surface (run/get/all/exec/tx) so the entire
// app + test suite is unchanged across engines:
//   • SQLite (default / local / tests)  → Node's built-in `node:sqlite`, file-backed.
//   • PostgreSQL (production)            → `pg` against DATABASE_URL=postgres://…
//   • PGlite (Postgres verify, no server)→ PG_ENGINE=pglite (in-process Postgres).
//
// The Postgres engines run in a worker thread; the main thread blocks on Atomics
// until each query completes, presenting a synchronous API. This lets the existing
// synchronous repository/route code (255 call sites) run on Postgres untouched.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(__dirname, '../../data/arabtec.db');

const RAW_URL = process.env.DATABASE_URL || '';
const PG_ENGINE = (process.env.PG_ENGINE || '').toLowerCase(); // 'pglite' to force in-process PG
const IS_PG = RAW_URL.startsWith('postgres://') || RAW_URL.startsWith('postgresql://') || PG_ENGINE === 'pglite';

// =====================================================================
// Postgres mode (worker + Atomics → synchronous)
// =====================================================================
function makePostgres() {
  const { Worker } = require('node:worker_threads');
  const signal = new SharedArrayBuffer(4);
  const lenBuf = new SharedArrayBuffer(8);          // [0]=len, [1]=overflow flag
  let dataBuf = new SharedArrayBuffer(1 << 20);     // 1 MB result buffer (grows on overflow)
  const sig = new Int32Array(signal);
  const lenArr = new Int32Array(lenBuf);

  const engine = PG_ENGINE === 'pglite' ? 'pglite' : 'pg';
  // PGlite can persist to a directory if PG_DATA is set; pg uses the connection string.
  const conn = engine === 'pglite' ? (process.env.PG_DATA || undefined) : RAW_URL;

  let worker = new Worker(new URL('./pg-worker.mjs', import.meta.url), {
    workerData: { signal, lenBuf, dataBuf, engine, conn },
  });
  worker.on('error', (e) => { console.error('PG worker error:', e); });

  function call(message, timeoutMs) {
    Atomics.store(sig, 0, 0);
    Atomics.store(lenArr, 1, 0);
    worker.postMessage(message);
    // Block until the worker signals done. A timeout (used only for the boot ping)
    // prevents a slow/failed DB connection from hanging the whole process at import.
    const res = Atomics.wait(sig, 0, 0, timeoutMs);
    if (res === 'timed-out') throw new Error('DB worker timed out');
    const overflow = Atomics.load(lenArr, 1);
    const len = Atomics.load(lenArr, 0);
    if (overflow) {
      // Grow buffer to fit and re-run (rare: very large result set).
      const need = Math.max(len + 1024, dataBuf.byteLength * 2);
      dataBuf = new SharedArrayBuffer(need);
      worker.terminate();
      worker = new Worker(new URL('./pg-worker.mjs', import.meta.url), {
        workerData: { signal, lenBuf, dataBuf, engine, conn },
      });
      return call(message);
    }
    const json = Buffer.from(dataBuf).toString('utf8', 0, len);
    const p = JSON.parse(json);
    if (!p.ok) throw new Error(p.error);
    return p;
  }

  // Best-effort readiness probe at import. Bounded so a slow remote Postgres can't
  // hang the process before the HTTP port binds. If it times out here, the first
  // real query (after the server is listening) simply waits the normal way.
  try { call({ type: 'ping' }, 8000); }
  catch (e) { console.warn('  • DB not ready at import (will connect on first query):', e.message); }

  // `txId` travels with every statement so the worker can route it to the
  // connection that ran BEGIN. It is threaded explicitly rather than kept as
  // ambient worker state, so two transactions can never see each other.
  const q = (sql, params, txId) =>
    call({ type: 'query', sql: translate(sql), params: normParams(params), txId });

  return {
    kind: engine === 'pglite' ? 'pglite' : 'postgres',
    run(sql, params = [], txId) {
      const t = translate(sql);
      const p = normParams(params);
      // Capture the new id for INSERTs (parity with SQLite lastInsertRowid). Tables
      // with a composite PK have no `id` column — fall back to a plain INSERT then.
      if (/^\s*insert\s/i.test(t) && !/returning/i.test(t)) {
        try {
          const r = call({ type: 'query', sql: t.replace(/;?\s*$/, ' RETURNING id'), params: p, txId });
          return { lastInsertRowid: r.rows?.[0]?.id ?? null, changes: r.affected ?? 0 };
        } catch (e) {
          if (!/column "id" does not exist/i.test(e.message)) throw e;
          const r = call({ type: 'query', sql: t, params: p, txId });
          return { lastInsertRowid: null, changes: r.affected ?? 0 };
        }
      }
      const r = call({ type: 'query', sql: t, params: p, txId });
      return { lastInsertRowid: null, changes: r.affected ?? 0 };
    },
    get(sql, params = [], txId) { const r = q(sql, params, txId).rows[0]; return r ? unmarshalRow(r) : r; },
    all(sql, params = [], txId) { return q(sql, params, txId).rows.map(unmarshalRow); },
    exec(sql, txId) {
      // exec may contain multiple statements (schema DDL). Split and run sequentially.
      for (const stmt of splitStatements(translate(sql))) {
        if (stmt.trim()) call({ type: 'query', sql: stmt, params: [], txId });
      }
    },
    txBegin() { return call({ type: 'txBegin' }).txId; },
    txCommit(txId) { call({ type: 'txCommit', txId }); },
    txRollback(txId) { call({ type: 'txRollback', txId }); },
  };
}

// Convert SQLite-flavored SQL → Postgres at the boundary.
function translate(sql) {
  let s = sql;
  // Datetime default/inline → now()
  s = s.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');
  // DDL: SQLite autoincrement PK → Postgres SERIAL
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  // DDL: SQLite BLOB column → Postgres BYTEA
  s = s.replace(/\bBLOB\b/gi, 'BYTEA');
  // INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING (append clause at end)
  let appendOnConflictNothing = false;
  if (/insert\s+or\s+ignore\s+into/i.test(s)) {
    s = s.replace(/insert\s+or\s+ignore\s+into/i, 'INSERT INTO');
    appendOnConflictNothing = true;
  }
  // INSERT OR REPLACE → INSERT (callers that need upsert use explicit ON CONFLICT already)
  s = s.replace(/insert\s+or\s+replace\s+into/i, 'INSERT INTO');
  // Positional params: ? → $1, $2, … (params array supplies the literals)
  let n = 0;
  s = s.replace(/\?/g, () => `$${++n}`);
  if (appendOnConflictNothing && !/on\s+conflict/i.test(s)) {
    s = s.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }
  // ON CONFLICT(col) DO UPDATE SET x=excluded.x  is valid in both — leave as-is.
  return s;
}
function normParams(params) {
  if (!params) return [];
  // Marshal params for postMessage→pg. Binary (Uint8Array/Buffer) can't cross the
  // worker boundary as-is, so wrap it as base64; the worker rebuilds a Buffer.
  return params.map((v) => {
    if (v === undefined) return null;
    if (v instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(v))) {
      return { __bin: Buffer.from(v).toString('base64') };
    }
    return v;
  });
}
// Convert binary fields in a result row back to Buffers. Across the worker's
// JSON boundary, a Buffer becomes {type:'Buffer',data:[...]} and a Uint8Array
// (PGlite BYTEA) becomes a plain {"0":n,"1":n,...} object — handle both.
function unmarshalRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of Object.keys(row)) {
    const val = row[k];
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    if (val.type === 'Buffer' && Array.isArray(val.data)) {
      row[k] = Buffer.from(val.data);
    } else {
      const keys = Object.keys(val);
      if (keys.length && keys.every((kk) => /^\d+$/.test(kk))) {
        // numeric-keyed byte map → Buffer
        row[k] = Buffer.from(keys.map((kk) => val[kk]));
      }
    }
  }
  return row;
}
function splitStatements(sql) {
  // Naive split on ';' at statement end — safe here because our DDL has no ';' inside literals.
  return sql.split(/;\s*(?:\n|$)/);
}

// =====================================================================
// SQLite mode (native node:sqlite, file-backed)
// =====================================================================
function makeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const url = RAW_URL;
  let dbPath = DEFAULT_FILE;
  if (url.startsWith('file:')) {
    const p = url.slice(5);
    dbPath = path.isAbsolute(p) ? p : path.resolve(__dirname, '../../prisma', p);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  const setJournal = (mode) => {
    db.exec(`PRAGMA journal_mode = ${mode};`);
    db.exec('CREATE TABLE IF NOT EXISTS _journal_probe (x INTEGER);');
    db.exec('INSERT INTO _journal_probe (x) VALUES (1);');
    db.exec('DELETE FROM _journal_probe;');
  };
  try { setJournal('WAL'); }
  catch { try { setJournal('DELETE'); } catch { try { db.exec('PRAGMA journal_mode = MEMORY;'); } catch {} } }
  return {
    kind: 'sqlite',
    run: (sql, params = []) => db.prepare(sql).run(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    all: (sql, params = []) => db.prepare(sql).all(...params),
    exec: (sql) => db.exec(sql),
  };
}

// =====================================================================
// Public surface
// =====================================================================
const impl = IS_PG ? makePostgres() : makeSqlite();

/* ----------------------------- transactions -------------------------------
   The call surface below is unchanged for all 255 existing call sites: they
   keep calling run/get/all/exec with no idea a transaction is open.

   A STACK, not a single "current transaction". Every statement issued while a
   transaction is open carries that transaction's id to the worker, which routes
   it to the connection that ran BEGIN. The stack exists so a nested tx() joins
   the outer one instead of issuing a second BEGIN, which Postgres would warn
   about and SQLite would reject outright.

   Safe under concurrency by construction: the whole surface is synchronous —
   the main thread blocks in Atomics.wait for every statement — so no other JS
   can run between BEGIN and COMMIT. The id is still threaded explicitly rather
   than read from worker state, so nothing depends on that timing detail.
   -------------------------------------------------------------------------- */

const txStack = [];
const activeTx = () => (txStack.length ? txStack[txStack.length - 1] : undefined);

export function run(sql, params = []) { return impl.run(sql, params, activeTx()); }
export function get(sql, params = []) { return impl.get(sql, params, activeTx()); }
export function all(sql, params = []) { return impl.all(sql, params, activeTx()); }
export function exec(sql) { return impl.exec(sql, activeTx()); }

/**
 * Run `fn` inside a transaction. All writes commit together or none do.
 *
 * Nested calls JOIN the outer transaction and do not commit early — only the
 * outermost `tx()` settles. That is the behaviour callers actually want: an
 * inner helper must not durably commit half of an outer operation.
 */
/**
 * THE CALLBACK MUST BE SYNCHRONOUS. Enforced, not merely documented.
 *
 * `txStack` is a module-global, which is only safe because the whole database
 * surface is synchronous: every statement blocks the main thread in
 * `Atomics.wait`, so no other JS can run between BEGIN and COMMIT and no second
 * caller can observe or mutate the stack mid-transaction.
 *
 * An async callback breaks that guarantee completely. `fn()` would return a
 * pending Promise, this function would commit immediately, the stack would
 * unwind, and the awaited work would then run OUTSIDE the transaction — on
 * pooled connections, autocommitting, with no rollback. Worse, control would
 * yield to the event loop while `txStack` still had an entry, so an unrelated
 * request could adopt this transaction's id.
 *
 * That failure is silent and would look like success, so a thenable result is
 * treated as a bug: roll back and throw. Converting `tx()` to support async
 * callbacks is possible but requires AsyncLocalStorage-based context instead of
 * a stack, which is the F-02 conversion and explicitly out of scope here.
 */
const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function')
  && typeof v.then === 'function';

const ASYNC_MSG = 'tx() requires a SYNCHRONOUS callback. It returned a Promise/thenable, '
  + 'which would commit before the work ran and leak transaction context across requests. '
  + 'The transaction was rolled back.';

export function tx(fn) {
  // Joining an outer transaction: still enforce the contract, because an async
  // inner callback would yield with the OUTER transaction open.
  if (txStack.length > 0) {
    const r = fn();
    if (isThenable(r)) throw new Error(ASYNC_MSG);
    return r;
  }

  if (impl.kind === 'sqlite') {
    // Single connection: affinity is inherent, so BEGIN/COMMIT on the handle is
    // already correct.
    //
    // BL-27. The stack is pushed here too, even though SQLite ignores the id.
    // It is what makes the nesting rule above apply to BOTH engines: without it
    // `txStack` stayed empty on SQLite, so an inner tx() issued a second BEGIN
    // and SQLite rejected it outright ("cannot start a transaction within a
    // transaction"). Postgres joined the outer transaction correctly, so a
    // composed operation — a join, which fills a seat inside its own
    // transaction — behaved differently on the two engines. A sentinel, not a
    // real id, because there is only ever one connection to route to.
    exec('BEGIN');
    txStack.push('sqlite');
    let result;
    try { result = fn(); }
    catch (e) { txStack.pop(); try { exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
    if (isThenable(result)) {
      txStack.pop();
      try { exec('ROLLBACK'); } catch { /* already unwound */ }
      throw new Error(ASYNC_MSG);
    }
    txStack.pop();
    try { exec('COMMIT'); } catch (e) { try { exec('ROLLBACK'); } catch { /* gone */ } throw e; }
    return result;
  }

  const txId = impl.txBegin();
  txStack.push(txId);
  let ok = false;
  try {
    const r = fn();
    if (isThenable(r)) {
      // Roll back BEFORE the stack unwinds, so nothing is committed and no
      // context survives.
      txStack.pop();
      try { impl.txRollback(txId); } catch { /* worker already settled it */ }
      throw new Error(ASYNC_MSG);
    }
    ok = true;
    // Pop BEFORE settling so COMMIT is not itself routed into the transaction.
    txStack.pop();
    impl.txCommit(txId);
    return r;
  } catch (e) {
    if (!ok && txStack[txStack.length - 1] === txId) {
      txStack.pop();
      // Roll back on every failure path — callback throw, query failure, or a
      // failed commit. The worker releases the client exactly once regardless.
      try { impl.txRollback(txId); } catch { /* worker already settled it */ }
    }
    throw e;
  }
}

export function driverKind() { return impl.kind; }
/** Test-only: is a transaction open on this process right now? */
export function inTransaction() { return txStack.length > 0; }

/**
 * TEST-ONLY. The raw transaction primitives, so a test can hold TWO
 * transactions open at once and prove they cannot see each other.
 *
 * `tx()` deliberately cannot do this — it is strictly scoped — which is exactly
 * why the isolation property needs a lower-level handle to demonstrate. Not for
 * production use: nothing outside a test may settle a transaction by hand.
 */
export function __txPrimitivesForTest() {
  if (impl.kind === 'sqlite') return null; // one connection; nothing to interleave
  return {
    begin: () => impl.txBegin(),
    commit: (id) => impl.txCommit(id),
    rollback: (id) => impl.txRollback(id),
    run: (sql, params, id) => impl.run(sql, params, id),
    get: (sql, params, id) => impl.get(sql, params, id),
  };
}

export default { run, get, all, exec, tx, driverKind, inTransaction };
