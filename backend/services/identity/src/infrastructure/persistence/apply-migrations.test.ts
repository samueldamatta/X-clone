import { describe, expect, it } from 'vitest';
import { applyMigrations, type MigrationConnection, type MigrationPool } from './apply-migrations';

function fakePool(alreadyApplied: string[] = []) {
  const applied = new Set(alreadyApplied);
  const log: string[] = [];
  let pendingInsertId: string | undefined;

  const connection: MigrationConnection & { release(): void } = {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const statement = sql.trim();
      log.push(statement.split('\n')[0] ?? statement);

      if (statement.includes('FAIL ME')) {
        return Promise.reject(new Error('simulated statement failure'));
      }
      if (statement.startsWith('CREATE TABLE')) {
        return Promise.resolve({ rows: [] });
      }
      if (statement.startsWith('SELECT id FROM')) {
        const rows = [...applied].map((id) => ({ id })) as T[];
        return Promise.resolve({ rows });
      }
      if (statement === 'BEGIN') {
        pendingInsertId = undefined;
        return Promise.resolve({ rows: [] });
      }
      if (statement.startsWith('INSERT INTO')) {
        pendingInsertId = params?.[0] as string;
        return Promise.resolve({ rows: [] });
      }
      if (statement === 'COMMIT') {
        if (pendingInsertId !== undefined) {
          applied.add(pendingInsertId);
        }
        return Promise.resolve({ rows: [] });
      }
      if (statement === 'ROLLBACK') {
        pendingInsertId = undefined;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
    release() {
      /* no-op */
    },
  };

  const pool: MigrationPool = { connect: () => Promise.resolve(connection) };
  return { pool, applied, log };
}

describe('applyMigrations', () => {
  it('applies pending migrations in order and records each one', async () => {
    const { pool, applied } = fakePool();

    const result = await applyMigrations(pool, [
      { id: '0000_a.sql', sql: 'CREATE TABLE a (id int);' },
      { id: '0001_b.sql', sql: 'CREATE TABLE b (id int);' },
    ]);

    expect(result).toEqual(['0000_a.sql', '0001_b.sql']);
    expect(applied).toEqual(new Set(['0000_a.sql', '0001_b.sql']));
  });

  it('skips migrations already recorded', async () => {
    const { pool } = fakePool(['0000_a.sql']);

    const result = await applyMigrations(pool, [
      { id: '0000_a.sql', sql: 'CREATE TABLE a (id int);' },
      { id: '0001_b.sql', sql: 'CREATE TABLE b (id int);' },
    ]);

    expect(result).toEqual(['0001_b.sql']);
  });

  it('rolls back and does not record a migration whose statement fails', async () => {
    const { pool, applied } = fakePool();

    await expect(
      applyMigrations(pool, [
        {
          id: '0000_bad.sql',
          sql: 'CREATE TABLE ok (id int);\n--> statement-breakpoint\nFAIL ME;',
        },
      ]),
    ).rejects.toThrow('simulated statement failure');

    expect(applied.size).toBe(0);
  });

  it('never issues CREATE SCHEMA — the bug this runner exists to avoid', async () => {
    const { pool, log } = fakePool();

    await applyMigrations(pool, [{ id: '0000_a.sql', sql: 'CREATE TABLE a (id int);' }]);

    expect(log.some((entry) => entry.includes('CREATE SCHEMA'))).toBe(false);
  });
});
