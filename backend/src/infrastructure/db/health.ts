// Database health probes.
//
// Lives here rather than in the health controller so the controller imports no
// driver: a controller that knows how to run `select 1` is a controller that
// could be asked to run something else.

import { sql } from 'drizzle-orm';
import type { Executor } from './types.js';

/** Cheapest possible round trip. Proves the connection, not the schema. */
export const databaseReachable = async (db: Executor): Promise<boolean> => {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
};
