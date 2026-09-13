import { eq } from 'drizzle-orm';
import type { ProfileRepository } from '../../domain/ports/profile-repository';
import type { Profile, ProfileChanges } from '../../domain/profile';
import type { Database } from './db';
import { users } from './schema';

/**
 * The columns a profile is made of, named once.
 *
 * Not `select()` with no argument: that reads every column, including
 * `follower_count` and `is_celebrity`, which nothing here returns. A query
 * that selects columns nobody reads is a query that grows by accident — and
 * the day `users` gains a private column, an unqualified select would start
 * carrying it into a public response.
 */
const PROFILE_COLUMNS = {
  id: users.id,
  handle: users.handle,
  displayName: users.displayName,
  bio: users.bio,
  createdAt: users.createdAt,
};

export class DrizzleProfileRepository implements ProfileRepository {
  constructor(private readonly db: Database) {}

  async findByHandle(handle: string): Promise<Profile | undefined> {
    const rows = await this.db
      .select(PROFILE_COLUMNS)
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);

    return rows[0];
  }

  async update(userId: string, changes: ProfileChanges): Promise<Profile | undefined> {
    /**
     * Built by spreading only the keys that are present, so an absent field
     * never reaches the SET clause. Passing `displayName: undefined`
     * straight through would be a different bug in each ORM — drizzle skips
     * it, but the rule that protects this is "the object has no such key",
     * not "the driver happens to ignore undefined".
     *
     * An empty string is a value here, not an absence: `bio: ''` writes ''.
     *
     * A `changes` with no keys at all would produce `SET` with nothing
     * after it. That case is refused a layer up, by the use case, because
     * "you asked for no change" is a 400 the caller deserves to read — not
     * a malformed statement for the database to complain about.
     */
    const patch = {
      ...(changes.displayName !== undefined && { displayName: changes.displayName }),
      ...(changes.bio !== undefined && { bio: changes.bio }),
    };

    const rows = await this.db
      .update(users)
      .set(patch)
      .where(eq(users.id, userId))
      .returning(PROFILE_COLUMNS);

    return rows[0];
  }
}
