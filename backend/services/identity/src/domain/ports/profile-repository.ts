import type { Profile, ProfileChanges } from '../profile';

/**
 * Separate from UserRepository, which serves the authentication path.
 *
 * They are backed by the same table, and merging them would be one class
 * instead of two. The reason not to: the login use case's test doubles
 * would then have to implement `update` and `findByHandle`, methods that
 * path never calls, and StoredCredentials exists precisely because that
 * path is deliberately narrow. Two ports over one table is the price of
 * each consumer seeing only what it uses.
 */
export interface ProfileRepository {
  /** Case-insensitive by column type (CITEXT), like every other handle lookup. */
  findByHandle(handle: string): Promise<Profile | undefined>;

  /**
   * Applies the changes and returns the row as it now stands — one round
   * trip, not an UPDATE followed by a SELECT that could read a third
   * party's concurrent write.
   *
   * Undefined when no account has that id. It is not a normal case: the id
   * comes from a verified access token, so the only way to reach it is an
   * account deleted while one of its tokens was still in circulation. The
   * caller turns it into the same not-found the public read produces.
   */
  update(userId: string, changes: ProfileChanges): Promise<Profile | undefined>;
}
