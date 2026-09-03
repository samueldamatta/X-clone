import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` needs no live connection — it reads schema.ts and
 * writes SQL. Only `db:migrate` (drizzle-orm's own migrator, not drizzle-kit)
 * connects, and it connects as identity_svc — see infrastructure/persistence/migrate.ts
 * and docs/adr/0007-bootstrap-versus-service-migrations.md.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/persistence/schema.ts',
  out: './src/infrastructure/persistence/migrations',
});
