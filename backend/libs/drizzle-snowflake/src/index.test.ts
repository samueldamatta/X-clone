import { pgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { snowflake } from './index';

describe('snowflake column type', () => {
  it('declares a bigint column, so Postgres never returns it as a JS number', () => {
    const table = pgTable('probe', { id: snowflake('id').notNull() });
    expect(table.id.getSQLType()).toBe('bigint');
  });
});
