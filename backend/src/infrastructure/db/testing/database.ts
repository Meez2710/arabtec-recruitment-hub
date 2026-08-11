// TEST SUPPORT ONLY — the integration harness.
//
// One entry point, two backends, identical behaviour:
//
//   PGlite      real PostgreSQL 18 compiled to WASM. Zero setup, so the suite
//               runs anywhere. SINGLE-CONNECTION: constraints, MVCC, rollback
//               and `FOR UPDATE` parsing are all genuine, but two transactions
//               cannot be in flight at once, so lock CONTENTION is unobservable.
//
//   PostgreSQL  a real server, used automatically when TEST_DATABASE_URL or
//               DATABASE_URL is set. Adds true concurrent sessions, which is
//               what the Step-11 blocking tests need.
//
// Both apply THE REAL MIGRATION FILES, in filename order, statement by
// statement. Not `drizzle-kit push`, not a schema sync — the point is to prove
// the SQL that will run against production actually runs, in the order it will
// run. A push-based harness would have missed drizzle silently dropping all
// eight CHECK constraints, which is a thing that already happened once.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Executor } from '../types.js';
import { resolveBackend, supportsConcurrentSessions } from './backend.js';
import type { BackendChoice, BackendKind } from './backend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../migrations');

/** Child-first so TRUNCATE never trips a RESTRICT foreign key. */
const TRUNCATE_TABLES = [
  'hiring_stage_history', 'hiring_seat', 'offer_compensation_line', 'offer',
  'interview_assessment', 'interview_panel', 'interview',
  'hiring_application', 'hiring_requisition',
  'ai_task', 'candidate_match', 'cv_intake_item', 'cv_intake_batch',
  'candidate_proposal', 'candidate_document', 'candidate',
  'outbox_event', 'processed_event', 'timeline_entry',
];

const ALL_SEQUENCES = [
  'seq_requisition_ticket_no', 'seq_application_no', 'seq_interview_no', 'seq_offer_no',
  'seq_candidate_no',
  'hiring_requisition_id_seq', 'hiring_seat_id_seq', 'hiring_application_id_seq',
  'hiring_stage_history_id_seq', 'interview_id_seq', 'interview_panel_id_seq',
  'interview_assessment_id_seq', 'offer_id_seq', 'offer_compensation_line_id_seq',
  'outbox_event_id_seq', 'timeline_entry_id_seq',
  'candidate_id_seq', 'candidate_document_id_seq', 'candidate_proposal_id_seq',
  'ai_task_id_seq', 'cv_intake_batch_id_seq', 'cv_intake_item_id_seq', 'candidate_match_id_seq',
];

const COMPONENT_SEED = `
  INSERT INTO "offer_compensation_component"
    ("code","tenant_id","label_en","label_ar","display_order","footnote_key","active")
  VALUES
    ('BASIC_SALARY',1,'Basic Salary','الراتب الأساسي',10,NULL,true),
    ('ACCOMMODATION',1,'Accommodation','بدل سكن',20,NULL,true),
    ('TRANSPORTATION',1,'Transportation','بدل انتقالات',30,NULL,true),
    ('OTHERS',1,'Others','أخرى',40,'others',true),
    ('AREA_ALLOWANCE',1,'Area Allowance','بدل موقع',50,'area_allowance',true)
  ON CONFLICT ("code") DO NOTHING;`;

/**
 * Counts the SQL a block of code actually issues.
 *
 * Drizzle's own logger hook, so it sees every statement the query builder emits
 * — including ones a reviewer would miss. This is what makes "no N+1" a
 * MEASURED property rather than an assertion about code someone read once.
 */
export class QueryLog {
  private readonly entries: string[] = [];
  private recording = false;

  logQuery(query: string): void {
    if (this.recording) this.entries.push(query);
  }

  start(): void {
    this.entries.length = 0;
    this.recording = true;
  }

  stop(): readonly string[] {
    this.recording = false;
    return [...this.entries];
  }

  /** Count statements whose text matches, e.g. /select .* from "hiring_seat"/. */
  matching(pattern: RegExp): number {
    return this.entries.filter((q) => pattern.test(q.toLowerCase())).length;
  }

  get count(): number {
    return this.entries.length;
  }

  get all(): readonly string[] {
    return [...this.entries];
  }
}

/** An independent connection. Only real PostgreSQL can provide more than one. */
export interface TestSession {
  readonly db: Executor;
  /** Raw SQL, for the manual BEGIN/COMMIT the lock-contention tests need. */
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  release(): Promise<void>;
}

export interface TestDatabase {
  readonly db: Executor;
  /** Statement counter for the N+1 and performance checks. */
  readonly queries: QueryLog;
  readonly backend: BackendKind;
  readonly backendReason: string;
  /** False on PGlite. Concurrency tests guard on this and skip with a reason. */
  readonly supportsConcurrentSessions: boolean;
  /** Ordered migration filenames actually applied — the determinism check reads this. */
  readonly appliedMigrations: readonly string[];
  connect(): Promise<TestSession>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export const migrationFiles = (): readonly string[] =>
  fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

const statementsOf = (file: string): readonly string[] =>
  fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const createTestDatabase = async (): Promise<TestDatabase> => {
  const choice = resolveBackend();
  return choice.kind === 'postgres'
    ? createPostgresDatabase(choice)
    : createPgliteDatabase(choice);
};

/* --------------------------------- PGlite --------------------------------- */

const createPgliteDatabase = async (choice: BackendChoice): Promise<TestDatabase> => {
  const client = new PGlite();
  const applied = migrationFiles();
  for (const file of applied) {
    for (const statement of statementsOf(file)) await client.exec(statement);
  }
  const queries = new QueryLog();
  const db = drizzlePglite(client, { logger: queries }) as unknown as Executor;

  return {
    db,
    queries,
    backend: 'pglite',
    backendReason: choice.reason,
    supportsConcurrentSessions: false,
    appliedMigrations: applied,
    async connect(): Promise<TestSession> {
      throw new Error(
        'PGlite is single-connection. Guard on `supportsConcurrentSessions` before calling connect().',
      );
    },
    async reset(): Promise<void> {
      await client.exec(`TRUNCATE ${TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE;`);
      for (const seq of ALL_SEQUENCES) {
        await client.exec(`ALTER SEQUENCE IF EXISTS "${seq}" RESTART WITH 1;`);
      }
      await client.exec(COMPONENT_SEED);
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
};

/* ------------------------------- PostgreSQL ------------------------------- */

const createPostgresDatabase = async (choice: BackendChoice): Promise<TestDatabase> => {
  const pool = new pg.Pool({
    connectionString: choice.connectionString,
    // Room for the harness plus the extra sessions the contention tests open.
    max: 10,
    connectionTimeoutMillis: 5_000,
  });

  // Clean slate. Migrations are NOT idempotent (`CREATE TYPE` is not guarded),
  // so this is also what makes "the migrations apply in order, from nothing" a
  // claim the suite actually verifies rather than assumes.
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

  const applied = migrationFiles();
  for (const file of applied) {
    for (const statement of statementsOf(file)) {
      try {
        await pool.query(statement);
      } catch (error) {
        throw new Error(
          `Migration ${file} failed on statement:\n${statement.slice(0, 300)}\n` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const queries = new QueryLog();
  const db = drizzleNode(pool, { logger: queries }) as unknown as Executor;

  return {
    db,
    queries,
    backend: 'postgres',
    backendReason: choice.reason,
    supportsConcurrentSessions: supportsConcurrentSessions(choice),
    appliedMigrations: applied,
    async connect(): Promise<TestSession> {
      const client = await pool.connect();
      return {
        db: drizzleNode(client) as unknown as Executor,
        async query(sql, params = []): Promise<unknown> {
          return client.query(sql, [...params]);
        },
        async release(): Promise<void> {
          // Discard rather than return-to-pool: a session used for manual
          // BEGIN/COMMIT may be left in an aborted transaction, and handing that
          // to the next test would produce failures nowhere near their cause.
          client.release(true);
        },
      };
    },
    async reset(): Promise<void> {
      await pool.query(
        `TRUNCATE ${TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`,
      );
      for (const seq of ALL_SEQUENCES) {
        await pool.query(`ALTER SEQUENCE IF EXISTS "${seq}" RESTART WITH 1;`);
      }
      await pool.query(COMPONENT_SEED);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
};
