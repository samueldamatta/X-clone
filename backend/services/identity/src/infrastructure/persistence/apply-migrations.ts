export interface Migration {
  id: string;
  sql: string;
}

export interface MigrationConnection {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface MigrationPool {
  connect(): Promise<MigrationConnection & { release(): void }>;
}

const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * A hand-rolled runner, not drizzle-orm's own `migrate()`: that helper
 * unconditionally issues `CREATE SCHEMA IF NOT EXISTS`, and Postgres checks
 * the CREATE privilege for that statement *before* checking whether the
 * schema already exists — so it fails under identity_svc even though
 * "identity" was created by the bootstrap already. Nothing here ever
 * creates a schema; the bookkeeping table is a plain CREATE TABLE, which
 * resolves into "identity" via the role's search_path (ADR 0007).
 */
export async function applyMigrations(
  pool: MigrationPool,
  migrations: Migration[],
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );

    const { rows } = await client.query<{ id: string }>(`SELECT id FROM "${MIGRATIONS_TABLE}"`);
    const done = new Set(rows.map((row) => row.id));

    for (const migration of migrations) {
      if (done.has(migration.id)) {
        continue;
      }

      await client.query('BEGIN');
      try {
        for (const statement of splitStatements(migration.sql)) {
          await client.query(statement);
        }
        await client.query(`INSERT INTO "${MIGRATIONS_TABLE}" (id) VALUES ($1)`, [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }

  return applied;
}

/** drizzle-kit separates statements with this marker rather than relying on `;` parsing. */
function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
