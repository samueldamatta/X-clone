import type { User } from '../user';

/**
 * Just enough to decide a login. Not the whole `User`: the only thing the
 * login path does with the account is mint a session for its id, and a
 * query that selects columns nobody reads is a query that grows by
 * accident.
 */
export interface StoredCredentials {
  readonly userId: string;
  readonly passwordHash: string;
}

export interface UserRepository {
  /** Case-insensitive by column type (CITEXT) in the real implementation. */
  existsByHandle(handle: string): Promise<boolean>;
  create(user: User, passwordHash: string): Promise<void>;

  /**
   * Undefined for an unknown handle. The caller must go on to spend the
   * same time it would have spent verifying — see LoginUseCase.
   */
  findCredentialsByHandle(handle: string): Promise<StoredCredentials | undefined>;
}
