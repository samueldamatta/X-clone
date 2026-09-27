import type { AccessTokenIssuer } from '../domain/ports/access-token-issuer';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { RefreshTokenFactory } from '../domain/ports/refresh-token-factory';
import type { StoredRefreshToken } from '../domain/refresh-token';
import type { Session } from '../domain/session';

export interface TokenLifetimes {
  accessTokenMs: number;
  refreshTokenMs: number;
}

export interface IssuedTokens {
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** The only time this value exists anywhere. Nothing stores it. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface MintedRefreshToken {
  /** Handed to the client once. */
  token: string;
  /** What gets stored: the hash, never the token. */
  row: StoredRefreshToken;
}

export function mintRefreshToken(
  factory: RefreshTokenFactory,
  ids: IdGenerator,
  sessionId: string,
  now: Date,
): MintedRefreshToken {
  const { token, hash } = factory.create();
  return {
    token,
    row: { id: ids.next(), sessionId, tokenHash: hash, spentAt: null, createdAt: now },
  };
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
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt: session.expiresAt,
  };
}
