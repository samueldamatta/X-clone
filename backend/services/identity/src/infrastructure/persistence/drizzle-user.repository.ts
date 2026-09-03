import { eq } from 'drizzle-orm';
import { HandleTakenError } from '../../domain/errors';
import type { UserRepository } from '../../domain/ports/user-repository';
import type { User } from '../../domain/user';
import type { Database } from './db';
import { credentials, users } from './schema';

/** Postgres error code for unique_violation. */
const UNIQUE_VIOLATION = '23505';

function pgCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('code' in error && error.code !== undefined) {
    return error.code;
  }
  // drizzle-orm wraps the driver error as DrizzleQueryError, with the
  // original pg error (carrying .code) on the standard Error#cause chain
  // rather than on the wrapper itself.
  if ('cause' in error) {
    return pgCode(error.cause);
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgCode(error) === UNIQUE_VIOLATION;
}

/**
 * Case-insensitive uniqueness comes from the `handle` column's CITEXT type,
 * not from anything here — `eq(users.handle, handle)` already compares
 * case-insensitively at the database level.
 */
export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async existsByHandle(handle: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, handle))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The use case already checked existsByHandle, but that check and this
   * insert are not atomic — two registrations for the same handle can race
   * between them. The UNIQUE constraint on `handle` is the real guard;
   * this turns its violation back into the domain error the caller expects
   * instead of a raw Postgres exception.
   */
  async create(user: User, passwordHash: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: user.id,
          handle: user.handle,
          displayName: user.displayName,
          createdAt: user.createdAt,
        });
        await tx.insert(credentials).values({
          userId: user.id,
          passwordHash,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HandleTakenError(user.handle);
      }
      throw error;
    }
  }
}
