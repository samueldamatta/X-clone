import { InvalidCredentialsError } from '../domain/errors';
import type { AccessTokenIssuer } from '../domain/ports/access-token-issuer';
import type { Clock } from '../domain/ports/clock';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { PasswordHasher } from '../domain/ports/password-hasher';
import type { RefreshTokenFactory } from '../domain/ports/refresh-token-factory';
import type { SessionRepository } from '../domain/ports/session-repository';
import type { UserRepository } from '../domain/ports/user-repository';
import type { Session } from '../domain/session';

export interface LoginInput {
  handle: string;
  password: string;
  /** Absent when the client sent no User-Agent header. */
  userAgent?: string;
}

export interface LoginResult {
  userId: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** The only time this value exists anywhere. Nothing stores it. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface TokenLifetimes {
  accessTokenMs: number;
  refreshTokenMs: number;
}

/**
 * Proves an account and opens a session.
 *
 * Note what is *not* here: no assertValidHandle, no assertValidPassword.
 * Register enforces those rules on the way in, and restating them on the
 * way back would be worse than redundant — a 400 for "handle too short"
 * next to a 401 for "handle unknown" tells an attacker which handles are
 * merely unregistered, which is the distinction this whole use case is
 * built to hide. An unregisterable handle is just a handle nobody has.
 */
export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly refreshTokens: RefreshTokenFactory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly lifetimes: TokenLifetimes,
  ) {}

  async execute(input: LoginInput): Promise<LoginResult> {
    const credentials = await this.users.findCredentialsByHandle(input.handle);

    if (credentials === undefined) {
      /**
       * A hash whose result is thrown away, and the most important line in
       * this file.
       *
       * Returning here directly would answer in well under a millisecond,
       * while a wrong password costs an argon2id verify — ~100ms, slow by
       * design. That gap is a reliable answer to "does this handle exist?"
       * for anyone timing the responses, and it defeats the identical error
       * a few lines below entirely.
       *
       * `hash` rather than a verify against some dummy constant: argon2's
       * hash and verify do the same work with the same parameters, so this
       * costs what the real path costs, and there is no hard-coded digest
       * to drift out of step with the hasher's settings.
       */
      await this.hasher.hash(input.password);
      throw new InvalidCredentialsError();
    }

    const matches = await this.hasher.verify(credentials.passwordHash, input.password);
    if (!matches) {
      throw new InvalidCredentialsError();
    }

    const now = this.clock.now();
    const refreshToken = this.refreshTokens.create();

    // Built before the insert, so a repository that rejects the row cannot
    // leave a token in the caller's hands that no session backs.
    const session: Session = {
      id: this.ids.next(),
      userId: credentials.userId,
      refreshTokenHash: refreshToken.hash,
      expiresAt: new Date(now.getTime() + this.lifetimes.refreshTokenMs),
      revokedAt: null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
    };

    await this.sessions.create(session);

    const accessTokenExpiresAt = new Date(now.getTime() + this.lifetimes.accessTokenMs);
    const accessToken = this.accessTokens.issue({
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
      refreshToken: refreshToken.token,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }
}
