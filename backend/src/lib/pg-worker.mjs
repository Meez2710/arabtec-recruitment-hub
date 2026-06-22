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

let query; // (sql, params) => Promise<{ rows, affected }>
let initError = null;
let ready = (async () => {
  try {
    if (ENGINE === 'pglite') {
      const { PGlite } = await import('@electric-sql/pglite');
      const db = new PGlite(CONN || undefined); // CONN may be a data dir for persistence
      query = async (sql, params) => {
        const r = await db.query(sql, unwrapParams(params));
        return { rows: r.rows, affected: r.affectedRows ?? 0 };
      };
    } else {
      const pg = (await import('pg')).default;
      const pool = new pg.Pool({ connectionString: CONN, max: 4, ssl: sslFor(CONN) });
      query = async (sql, params) => {
        const r = await pool.query(sql, unwrapParams(params));
        return { rows: r.rows, affected: r.rowCount ?? 0 };
      };
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
  // Most managed Postgres (Render, Neon, Supabase) require SSL; disable cert check for those.
  if (/sslmode=require/.test(conn) || /render\.com|neon\.tech|supabase\.co|amazonaws\.com/.test(conn)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
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
    const out = await query(msg.sql, msg.params);
    respond({ ok: true, rows: out.rows, affected: out.affected });
  } catch (e) {
    // Always respond so the main thread's Atomics.wait is released.
    respond({ ok: false, error: e.message || String(e) });
  }
});
