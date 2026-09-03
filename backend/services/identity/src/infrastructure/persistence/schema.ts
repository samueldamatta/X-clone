import { snowflake } from '@x-clone/drizzle-snowflake';
import { boolean, customType, integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `identity.*` — only `users` and `credentials`. `sessions` (data-model.md
 * also lists it under this service) arrives with the login ticket; adding
 * it now would be a table nothing in this ticket writes to or reads from.
 */
export const identitySchema = pgSchema('identity');

/**
 * No drizzle-core helper exists for CITEXT — it is a Postgres extension
 * type, not a built-in one — so it gets the same customType treatment as
 * snowflake. Case-insensitive comparison is enforced by this column type,
 * not by application code: docs/03-data-model.md.
 *
 * Schema-qualified as `public.citext`: the bootstrap installs the extension
 * into `public` (Postgres's default for CREATE EXTENSION), but identity_svc's
 * search_path is set to `identity` only (ADR 0007) — an unqualified
 * `citext` does not resolve under that role even though the type exists.
 */
const citext = customType<{ data: string }>({
  dataType: () => 'public.citext',
});

export const users = identitySchema.table('users', {
  id: snowflake('id').primaryKey(),
  handle: citext('handle').notNull().unique(),
  displayName: text('display_name').notNull(),
  bio: text('bio').notNull().default(''),
  avatarMediaId: snowflake('avatar_media_id'),
  followerCount: integer('follower_count').notNull().default(0),
  followingCount: integer('following_count').notNull().default(0),
  isCelebrity: boolean('is_celebrity').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const credentials = identitySchema.table('credentials', {
  userId: snowflake('user_id')
    .primaryKey()
    .references(() => users.id),
  // argon2id — see docs/03-data-model.md and infrastructure/security/argon2-password-hasher.ts.
  passwordHash: text('password_hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
