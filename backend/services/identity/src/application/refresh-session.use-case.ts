import { InvalidRefreshTokenError } from '../domain/errors';
import type { AccessTokenIssuer } from '../domain/ports/access-token-issuer';
import type { Clock } from '../domain/ports/clock';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { RefreshTokenFactory } from '../domain/ports/refresh-token-factory';
import type { SessionRepository } from '../domain/ports/session-repository';
import type { StoredRefreshToken } from '../domain/refresh-token';
import { issueTokens, type IssuedTokens, type TokenLifetimes } from './issued-tokens';

export interface RefreshSessionInput {
  refreshToken: string;
}

export class RefreshSessionUseCase {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly refreshTokens: RefreshTokenFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly lifetimes: TokenLifetimes,
  ) {}

  async execute(input: RefreshSessionInput): Promise<IssuedTokens> {
    const found = await this.sessions.findByTokenHash(this.refreshTokens.hash(input.refreshToken));
    if (found === undefined) {
      throw new InvalidRefreshTokenError();
    }

    const { session, token } = found;
    const now = this.clock.now();

    if (token.spentAt !== null) {
      await this.sessions.revoke(session.id, now);
      throw new InvalidRefreshTokenError();
    }

    if (now >= session.expiresAt) {
      throw new InvalidRefreshTokenError();
    }

    const minted = this.refreshTokens.create();
    const next: StoredRefreshToken = {
      id: this.ids.next(),
      sessionId: session.id,
      tokenHash: minted.hash,
      spentAt: null,
      createdAt: now,
    };

    // Lost a race for this token: someone else spent it between our read and our write — reuse, same as above.
    if (!(await this.sessions.rotate(token.id, next, now))) {
      await this.sessions.revoke(session.id, now);
      throw new InvalidRefreshTokenError();
    }

    return issueTokens(this.accessTokens, session, minted.token, now, this.lifetimes);
  }
}
