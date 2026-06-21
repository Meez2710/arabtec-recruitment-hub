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

  function call(message) {
    Atomics.store(sig, 0, 0);
    Atomics.store(lenArr, 1, 0);
    worker.postMessage(message);
    Atomics.wait(sig, 0, 0);                          // block until worker signals done
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

  // Block until the engine is ready (connects / boots PGlite).
  call({ type: 'ping' });

  const q = (sql, params) => call({ type: 'query', sql: translate(sql), params: normParams(params) });

  return {
    kind: engine === 'pglite' ? 'pglite' : 'postgres',
    run(sql, params = []) {
      const t = translate(sql);
      const p = normParams(params);
      // Capture the new id for INSERTs (parity with SQLite lastInsertRowid). Tables
      // with a composite PK have no `id` column — fall back to a plain INSERT then.
      if (/^\s*insert\s/i.test(t) && !/returning/i.test(t)) {
        try {
          const r = call({ type: 'query', sql: t.replace(/;?\s*$/, ' RETURNING id'), params: p });
          return { lastInsertRowid: r.rows?.[0]?.id ?? null, changes: r.affected ?? 0 };
        } catch (e) {
          if (!/column "id" does not exist/i.test(e.message)) throw e;
          const r = call({ type: 'query', sql: t, params: p });
          return { lastInsertRowid: null, changes: r.affected ?? 0 };
        }
      }
      const r = call({ type: 'query', sql: t, params: p });
      return { lastInsertRowid: null, changes: r.affected ?? 0 };
    },
    get(sql, params = []) { const r = q(sql, params).rows[0]; return r ? unmarshalRow(r) : r; },
    all(sql, params = []) { return q(sql, params).rows.map(unmarshalRow); },
    exec(sql) {
      // exec may contain multiple statements (schema DDL). Split and run sequentially.
      for (const stmt of splitStatements(translate(sql))) {
        if (stmt.trim()) call({ type: 'query', sql: stmt, params: [] });
      }
    },
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

export function run(sql, params = []) { return impl.run(sql, params); }
export function get(sql, params = []) { return impl.get(sql, params); }
export function all(sql, params = []) { return impl.all(sql, params); }
export function exec(sql) { return impl.exec(sql); }
export function tx(fn) {
  exec('BEGIN');
  try { const r = fn(); exec('COMMIT'); return r; }
  catch (e) { try { exec('ROLLBACK'); } catch {} throw e; }
}
export function driverKind() { return impl.kind; }
export default { run, get, all, exec, tx, driverKind };
