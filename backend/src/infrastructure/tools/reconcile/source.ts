// Read-only snapshot readers for the LEGACY database.
//
// Deliberately separate from the runtime data layer: this is a one-time
// migration tool, not part of the architecture. It touches the legacy tables
// (`recruitment_request`, `requisition_seat`, `application`) and nothing else.
//
// EVERY query here is a SELECT. The tool opens no write path at all — a
// reconciliation run against production must be incapable of changing it.

import { createRequire } from 'node:module';
import type { LegacySnapshot } from './checks.js';

const require = createRequire(import.meta.url);

const SQL = {
  requisitions: `SELECT id, ticket_no, status, headcount, headcount_filled
                 FROM recruitment_request`,
  seats: `SELECT id, request_id, seat_no, status, filled_by_application_id
          FROM requisition_seat`,
  applications: `SELECT id, application_no, candidate_id, request_id, status
                 FROM application`,
} as const;

export interface SourceConfig {
  /** `file:/path/to.db` or a `postgres://…` connection string. */
  readonly url: string;
}

export interface SnapshotSource {
  readonly kind: 'sqlite' | 'postgres';
  read(): Promise<LegacySnapshot>;
  close(): Promise<void>;
}

export function openSource(config: SourceConfig): SnapshotSource {
  const isPg = /^postgres(ql)?:\/\//.test(config.url);
  return isPg ? openPostgres(config.url) : openSqlite(config.url);
}

/* --------------------------------- SQLite --------------------------------- */

function openSqlite(url: string): SnapshotSource {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const path = url.startsWith('file:') ? url.slice(5) : url;
  // `readOnly` is the guarantee, not a convention.
  const db = new DatabaseSync(path, { readOnly: true });

  return {
    kind: 'sqlite',
    async read(): Promise<LegacySnapshot> {
      return {
        requisitions: db.prepare(SQL.requisitions).all() as never,
        seats: db.prepare(SQL.seats).all() as never,
        applications: db.prepare(SQL.applications).all() as never,
      };
    },
    async close(): Promise<void> { db.close(); },
  };
}

/* -------------------------------- PostgreSQL ------------------------------- */

function openPostgres(url: string): SnapshotSource {
  const pg = require('pg') as typeof import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });

  return {
    kind: 'postgres',
    async read(): Promise<LegacySnapshot> {
      const client = await pool.connect();
      try {
        // A read-only, repeatable-read transaction: every table is read from the
        // same snapshot, so a concurrent write cannot make the report internally
        // inconsistent (seats counted after a hire the requisition read missed).
        await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
        const [requisitions, seats, applications] = await Promise.all([
          client.query(SQL.requisitions),
          client.query(SQL.seats),
          client.query(SQL.applications),
        ]);
        await client.query('COMMIT');
        return {
          requisitions: requisitions.rows as never,
          seats: seats.rows as never,
          applications: applications.rows as never,
        };
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> { await pool.end(); },
  };
}
