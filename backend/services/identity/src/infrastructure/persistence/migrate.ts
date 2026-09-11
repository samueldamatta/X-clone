import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { applyMigrations, type Migration } from './apply-migrations';

/**
 * Runs pending migrations as an explicit step, connected as identity_svc —
 * never the postgres superuser. See docs/adr/0007-bootstrap-versus-service-migrations.md
 * for why this is a separate step rather than something startup ordering
 * could paper over, and apply-migrations.ts for why this does not use
 * drizzle-orm's own migrator.
 */
function readMigrations(migrationsDir: string): Migration[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ id: file, sql: readFileSync(join(migrationsDir, file), 'utf8') }));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is not set.');
  }

  const migrations = readMigrations(join(__dirname, 'migrations'));
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const applied = await applyMigrations(pool, migrations);
    if (applied.length === 0) {
      console.log('identity: no pending migrations');
    } else {
      console.log(
        `identity: applied ${applied.length.toString()} migration(s): ${applied.join(', ')}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('identity migration failed', error);
  process.exit(1);
});
