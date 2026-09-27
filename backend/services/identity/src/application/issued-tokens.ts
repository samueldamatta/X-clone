import type { AccessTokenIssuer } from '../domain/ports/access-token-issuer';
import type { Session } from '../domain/session';

export interface TokenLifetimes {
  accessTokenMs: number;
  refreshTokenMs: number;
}

/** What login and refresh both answer with. */
export interface IssuedTokens {
  userId: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** The only time this value exists anywhere. Nothing stores it. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export function issueTokens(
  accessTokens: AccessTokenIssuer,
  session: Session,
  refreshToken: string,
  now: Date,
  lifetimes: TokenLifetimes,
): IssuedTokens {
  const accessTokenExpiresAt = new Date(now.getTime() + lifetimes.accessTokenMs);
  const accessToken = accessTokens.issue({
    userId: session.userId,
    sessionId: session.id,
    issuedAt: now,
    expiresAt: accessTokenExpiresAt,
  });

  return {
    userId: session.userId,
    sessionId: session.id,
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt: session.expiresAt,
  };
}
