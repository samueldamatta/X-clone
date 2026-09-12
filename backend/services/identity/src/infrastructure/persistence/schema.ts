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

/**
 * One row per login. The refresh token itself is never here — only its
 * hash, for the same reason `credentials` holds no password: a dump of this
 * table must not hand over live sessions.
 *
 * `revoked_at` rather than a DELETE. A revoked session is evidence: #8's
 * reuse detection has to tell "this refresh token never existed" apart from
 * "this refresh token was already spent", and a deleted row cannot make
 * that distinction.
 *
 * No index on `refresh_token_hash` yet. Looking a session up by its token
 * is what refresh does, and refresh is #8; an index nothing queries is
 * write cost with no read to pay for it.
 */
export const sessions = identitySchema.table(
  'sessions',
  {
    id: snowflake('id').primaryKey(),
    userId: snowflake('user_id')
      .notNull()
      .references(() => users.id),
    refreshTokenHash: text('refresh_token_hash').notNull(),
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
