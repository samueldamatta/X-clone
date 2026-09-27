import { snowflake } from '@x-clone/drizzle-snowflake';
import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** `identity.*` — `users`, `credentials`, and `sessions`. */
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

/** One row per login; revoked rather than deleted, because its spent tokens must still resolve to it. */
export const sessions = identitySchema.table(
  'sessions',
  {
    id: snowflake('id').primaryKey(),
    userId: snowflake('user_id')
      .notNull()
      .references(() => users.id),
    // Absolute: rotation never moves it.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * Nullable, and deliberately unvalidated: it is a request header, so it
     * is whatever the client chose to send. It exists so a person can
     * recognise their own sessions in a future "where you are logged in"
     * screen, and for nothing the server decides on.
     */
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Partial, matching docs/03-data-model.md. The query it serves is "the
     * live sessions of user X" — what #9's logout asks, and what any "where
     * you are logged in" screen asks. Revoked rows are never deleted, so
     * they accumulate forever; keeping them out of the index means the
     * live ones stay cheap to find however long the account has existed.
     */
    index('sessions_active_by_user_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

// No index on session_id: revocation writes `sessions`, and nothing queries this table by it.
export const refreshTokens = identitySchema.table('refresh_tokens', {
  id: snowflake('id').primaryKey(),
  sessionId: snowflake('session_id')
    .notNull()
    .references(() => sessions.id),
  tokenHash: text('token_hash').notNull().unique(),
  spentAt: timestamp('spent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
