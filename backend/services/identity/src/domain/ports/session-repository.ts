import type { StoredRefreshToken } from '../refresh-token';
import type { Session } from '../session';

export interface SessionWithToken {
  session: Session;
  token: StoredRefreshToken;
}

export interface SessionRepository {
  create(session: Session, firstToken: StoredRefreshToken): Promise<void>;

  findByTokenHash(tokenHash: string): Promise<SessionWithToken | undefined>;

  /** Atomic; false if the token was already spent or its session revoked when the write landed. */
  rotate(spentTokenId: string, next: StoredRefreshToken, spentAt: Date): Promise<boolean>;

  /** Keeps the first revocation time if the session was already revoked. */
  revoke(sessionId: string, revokedAt: Date): Promise<void>;
}
