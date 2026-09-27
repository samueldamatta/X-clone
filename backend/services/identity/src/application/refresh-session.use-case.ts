import { InvalidRefreshTokenError } from '../domain/errors';
import type { AccessTokenIssuer } from '../domain/ports/access-token-issuer';
import type { Clock } from '../domain/ports/clock';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { RefreshTokenFactory } from '../domain/ports/refresh-token-factory';
import type { SessionRepository } from '../domain/ports/session-repository';
import {
  issueTokens,
  mintRefreshToken,
  type IssuedTokens,
  type TokenLifetimes,
} from './issued-tokens';

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
      return this.rejectAsReuse(session.id, now);
    }

    if (now >= session.expiresAt) {
      throw new InvalidRefreshTokenError();
    }

    const next = mintRefreshToken(this.refreshTokens, this.ids, session.id, now);

    // False means the token was spent (or its session revoked) after we read it: a lost race is a replay too.
    if (!(await this.sessions.rotate(token.id, next.row, now))) {
      return this.rejectAsReuse(session.id, now);
    }

    return issueTokens(this.accessTokens, session, next.token, now, this.lifetimes);
  }

  private async rejectAsReuse(sessionId: string, now: Date): Promise<never> {
    await this.sessions.revoke(sessionId, now);
    throw new InvalidRefreshTokenError();
  }
}
