import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  pool: Pool;
  db: Database;
}

/**
 * One connection pool per process, created from the identity_svc connection
 * string (never the superuser's) — the role that ADR 0007 grants exactly
 * `identity.*` and nothing else.
 */
export function createDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
