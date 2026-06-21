// Database access layer for Arabtec Recruitment Hub.
//
// Driver: Node's built-in `node:sqlite` (Node >= 22.5), file-backed. On Render
// the file lives on a mounted persistent disk (see render.yaml) so data survives
// restarts and redeploys. Raw, explicit SQL keeps the PostgreSQL migration path
// transparent (prisma/schema.prisma = canonical model, docs/SCHEMA.sql = DDL).
//
// Production note: a managed-Postgres conversion (async pg layer) is the planned
// next step before IT handover; the schema is already Postgres-ready.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(__dirname, '../../data/arabtec.db');

// Resolve DB path from DATABASE_URL ("file:./dev.db" or "file:/abs/path") or default.
function resolveDbPath() {
  const url = process.env.DATABASE_URL || '';
  if (url.startsWith('file:')) {
    const p = url.slice(5);
    return path.isAbsolute(p) ? p : path.resolve(__dirname, '../../prisma', p);
  }
  return DEFAULT_FILE;
}

const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON;');
// Journal mode: WAL is faster but breaks on overlay / network / some synced
// filesystems with "disk I/O error". Verify the mode with a real write; if WAL
// can't commit, fall back to the universally-compatible rollback journal.
function setJournal(mode) {
  db.exec(`PRAGMA journal_mode = ${mode};`);
  db.exec('CREATE TABLE IF NOT EXISTS _journal_probe (x INTEGER);');
  db.exec('INSERT INTO _journal_probe (x) VALUES (1);');
  db.exec('DELETE FROM _journal_probe;');
}
try { setJournal('WAL'); }
catch { try { setJournal('DELETE'); } catch { try { db.exec('PRAGMA journal_mode = MEMORY;'); } catch {} } }

// --- Helpers -------------------------------------------------------------
export function run(sql, params = []) { return db.prepare(sql).run(...params); }
export function get(sql, params = []) { return db.prepare(sql).get(...params); }
export function all(sql, params = []) { return db.prepare(sql).all(...params); }
export function exec(sql) { return db.exec(sql); }
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export default db;
