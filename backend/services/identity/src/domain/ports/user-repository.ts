import type { User } from '../user';

export interface UserRepository {
  /** Case-insensitive by column type (CITEXT) in the real implementation. */
  existsByHandle(handle: string): Promise<boolean>;
  create(user: User, passwordHash: string): Promise<void>;
}
