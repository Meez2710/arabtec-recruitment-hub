// Worker thread: runs the Postgres engine and answers queries from the main
// thread synchronously (the main thread blocks on Atomics until we signal done).
//   • Production: `pg` Pool against DATABASE_URL (postgres://…)
//   • Local verify: PGlite (in-process Postgres, no server needed) when PG_ENGINE=pglite
import { parentPort, workerData } from 'node:worker_threads';

const sig = new Int32Array(workerData.signal);   // [0]=status (0 waiting, 1 done)
const lenArr = new Int32Array(workerData.lenBuf); // [0]=result byte length, [1]=overflow flag
const dataBuf = Buffer.from(workerData.dataBuf);  // shared result bytes (JSON)

const ENGINE = workerData.engine; // 'pg' | 'pglite'
const CONN = workerData.conn;

let query; // (sql, params) => Promise<{ rows, affected }>  — NON-transactional path
let checkout = null; // () => Promise<client>  — pins ONE connection for a transaction
let initError = null;

/* ------------------------- transaction registry ---------------------------
   F-01. `pool.query()` acquires a connection, runs one statement and releases
   it. So a transaction driven by repeated pool.query() calls is not a
   transaction at all: BEGIN opens one on connection A which is then handed back
   to the pool, the writes autocommit on B/C/D, and COMMIT lands wherever it
   lands. Under concurrency another request's statements can execute inside the
   open transaction, and a ROLLBACK then discards *its* writes.

   Fix: a transaction checks out its own client and every statement carrying its
   txId is routed to that client. Non-transactional queries keep using the pool.
   There is deliberately NO ambient "current transaction" here — the id travels
   with each message, so two concurrent transactions cannot see each other.
   -------------------------------------------------------------------------- */

const transactions = new Map(); // txId -> { client, settled, timer }
let txCounter = 0;

// An abandoned transaction would hold a pooled connection forever and, at max:4,
// starve the pool. Bounded so a crashed caller cannot wedge the process.
const TX_MAX_MS = Number(process.env.PG_TX_TIMEOUT_MS || 30000);

function forget(txId) {
  const t = transactions.get(txId);
  if (!t) return null;
  if (t.timer) clearTimeout(t.timer);
  transactions.delete(txId);
  return t;
}

/** Release exactly once, whatever path got us here. */
function releaseOnce(t) {
  if (t.settled) return;
  t.settled = true;
  try { if (t.client && t.client.release) t.client.release(); } catch { /* already gone */ }
}

let ready = (async () => {
  try {
    if (ENGINE === 'pglite') {
      const { PGlite } = await import('@electric-sql/pglite');
      const db = new PGlite(CONN || undefined); // CONN may be a data dir for persistence
      query = async (sql, params) => {
        const r = await db.query(sql, unwrapParams(params));
        return { rows: r.rows, affected: r.affectedRows ?? 0 };
      };
      // PGlite is ONE in-process connection, so affinity is automatic and there
      // is nothing to check out. It therefore cannot exercise the pool bug above
      // and can never stand in for a real Postgres transaction test.
      checkout = async () => ({
        query: (sql, params) => db.query(sql, unwrapParams(params))
          .then((r) => ({ rows: r.rows, rowCount: r.affectedRows ?? 0 })),
        release: () => {},
      });
    } else {
      const pg = (await import('pg')).default;
      // Parse bigint (int8, OID 20) and numeric (OID 1700) as JS numbers so COUNT(*)
      // and SUM() come back as numbers, not strings (which would break arithmetic).
      pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
      pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
      const pool = new pg.Pool({ connectionString: CONN, max: 4, ssl: sslFor(CONN), connectionTimeoutMillis: 10000 });
      // Actively verify the connection now so a bad SSL/host surfaces as a clear
      // error instead of a silent hang on the first real query.
      const probe = await pool.connect();
      await probe.query('SELECT 1');
      probe.release();
      query = async (sql, params) => {
        const r = await pool.query(sql, unwrapParams(params));
        return { rows: r.rows, affected: r.rowCount ?? 0 };
      };
      checkout = () => pool.connect();
    }
  } catch (e) {
    // Record but DON'T throw — the message handler must always be able to respond,
    // otherwise the main thread blocks forever on Atomics.wait.
    initError = e.message || String(e);
  }
})();

// Rebuild binary params: the main thread sends Buffers as { __bin: base64 }.
function unwrapParams(params) {
  if (!params || !params.length) return params || [];
  return params.map((v) => (v && typeof v === 'object' && typeof v.__bin === 'string')
    ? Buffer.from(v.__bin, 'base64') : v);
}

function sslFor(conn) {
  if (!conn) return undefined;
  // Localhost / 127.0.0.1 → no SSL. Everything else (any managed/remote Postgres,
  // including Render's INTERNAL hostname which doesn't contain "render.com") → SSL
  // with relaxed cert check. This is the common cause of a silent connect hang.
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(conn) || process.env.PG_NO_SSL === 'true') return undefined;
  if (/sslmode=disable/.test(conn)) return undefined;
  return { rejectUnauthorized: false };
}

function respond(payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  if (json.length > dataBuf.length) {
    Atomics.store(lenArr, 1, 1); // overflow flag → main thread grows buffer & retries
    Atomics.store(lenArr, 0, json.length);
  } else {
    Atomics.store(lenArr, 1, 0);
    json.copy(dataBuf, 0, 0, json.length);
    Atomics.store(lenArr, 0, json.length);
  }
  Atomics.store(sig, 0, 1);
  Atomics.notify(sig, 0);
}

parentPort.on('message', async (msg) => {
  try {
    await ready; // never throws now (errors captured into initError)
    if (msg.type === 'ping') { respond({ ok: true, ready: !initError, error: initError || undefined }); return; }
    if (initError || !query) { respond({ ok: false, error: 'DB not initialised: ' + (initError || 'unknown') }); return; }

    /* ------------------------------ BEGIN -------------------------------- */
    if (msg.type === 'txBegin') {
      const client = await checkout();
      const txId = `tx${++txCounter}`;
      const t = { client, settled: false, timer: null };
      // Roll back and release if the caller never settles. Without this an
      // abandoned transaction holds a pooled connection until the process dies.
      t.timer = setTimeout(() => {
        if (transactions.get(txId) !== t) return;
        transactions.delete(txId);
        Promise.resolve()
          .then(() => client.query('ROLLBACK'))
          .catch(() => {})
          .finally(() => releaseOnce(t));
      }, TX_MAX_MS);
      if (t.timer.unref) t.timer.unref();
      try {
        await client.query('BEGIN');
      } catch (e) {
        forget(txId); releaseOnce(t);
        respond({ ok: false, error: e.message || String(e) });
        return;
      }
      transactions.set(txId, t);
      respond({ ok: true, txId });
      return;
    }

    /* --------------------------- COMMIT / ROLLBACK ------------------------ */
    if (msg.type === 'txCommit' || msg.type === 'txRollback') {
      const t = forget(msg.txId);
      if (!t) {
        // Unknown or already-settled id. Never silently succeed: a caller that
        // thinks it committed when nothing happened is the failure mode this
        // whole change exists to remove.
        respond({ ok: false, error: `Unknown transaction: ${msg.txId}` });
        return;
      }
      const verb = msg.type === 'txCommit' ? 'COMMIT' : 'ROLLBACK';
      try {
        await t.client.query(verb);
        respond({ ok: true });
      } catch (e) {
        // A failed COMMIT leaves the transaction open on that client; roll it
        // back so the connection returns to the pool clean.
        if (verb === 'COMMIT') { try { await t.client.query('ROLLBACK'); } catch { /* gone */ } }
        respond({ ok: false, error: e.message || String(e) });
      } finally {
        releaseOnce(t); // exactly once, on every path
      }
      return;
    }

    /* ------------------------------ QUERY --------------------------------- */
    if (msg.txId) {
      const t = transactions.get(msg.txId);
      if (!t) { respond({ ok: false, error: `Unknown transaction: ${msg.txId}` }); return; }
      // Pinned client — same connection as BEGIN and as the eventual COMMIT.
      const r = await t.client.query(msg.sql, unwrapParams(msg.params));
      respond({ ok: true, rows: r.rows, affected: r.rowCount ?? 0 });
      return;
    }

    const out = await query(msg.sql, msg.params);
    respond({ ok: true, rows: out.rows, affected: out.affected });
  } catch (e) {
    // Always respond so the main thread's Atomics.wait is released.
    respond({ ok: false, error: e.message || String(e) });
  }
});
