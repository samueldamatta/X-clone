import { and, eq, isNull } from 'drizzle-orm';
import type { SessionRepository, SessionWithToken } from '../../domain/ports/session-repository';
import type { StoredRefreshToken } from '../../domain/refresh-token';
import type { Session } from '../../domain/session';
import type { Database } from './db';
import { refreshTokens, sessions } from './schema';

export class DrizzleSessionRepository implements SessionRepository {
  constructor(private readonly db: Database) {}

  async create(session: Session, firstToken: StoredRefreshToken): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(sessions).values(session);
      await tx.insert(refreshTokens).values(firstToken);
    });
  }

  async findByTokenHash(tokenHash: string): Promise<SessionWithToken | undefined> {
    const rows = await this.db
      .select({ session: sessions, token: refreshTokens })
      .from(refreshTokens)
      .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    return rows[0];
  }

  async rotate(spentTokenId: string, next: StoredRefreshToken, spentAt: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // FOR SHARE waits out an in-flight revoke and sees its commit; a later revoke waits for us.
      const live = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, next.sessionId), isNull(sessions.revokedAt)))
        .for('share');
      if (live.length === 0) {
        return false;
      }

      // Two spends of one token serialise on its row lock; the second re-checks spent_at and matches nothing.
      const spent = await tx
        .update(refreshTokens)
        .set({ spentAt })
        .where(
          and(
            eq(refreshTokens.id, spentTokenId),
            eq(refreshTokens.sessionId, next.sessionId),
            isNull(refreshTokens.spentAt),
          ),
        )
        .returning({ id: refreshTokens.id });
      if (spent.length === 0) {
        return false;
      }

      await tx.insert(refreshTokens).values(next);
      return true;
    });
  }

  async revoke(sessionId: string, revokedAt: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }
}
