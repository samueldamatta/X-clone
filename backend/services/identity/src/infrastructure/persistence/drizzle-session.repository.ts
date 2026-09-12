import type { SessionRepository } from '../../domain/ports/session-repository';
import type { Session } from '../../domain/session';
import type { Database } from './db';
import { sessions } from './schema';

/**
 * A plain insert, and no transaction: one row, one statement, already
 * atomic. DrizzleUserRepository.create wraps its work because it touches
 * two tables and half of that would be a user with no password.
 */
export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async create(session: Session): Promise<void> {
    await this.db.insert(sessions).values({
      id: session.id,
      userId: session.userId,
      refreshTokenHash: session.refreshTokenHash,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
    });
  }
}
