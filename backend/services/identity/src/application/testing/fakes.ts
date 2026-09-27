import { createHash } from 'node:crypto';
import type { AccessTokenClaims, AccessTokenIssuer } from '../../domain/ports/access-token-issuer';
import type { Clock } from '../../domain/ports/clock';
import type { IdGenerator } from '../../domain/ports/id-generator';
import type { PasswordHasher } from '../../domain/ports/password-hasher';
import type { RefreshToken, RefreshTokenFactory } from '../../domain/ports/refresh-token-factory';
import type { SessionRepository, SessionWithToken } from '../../domain/ports/session-repository';
import type { StoredCredentials, UserRepository } from '../../domain/ports/user-repository';
import type { StoredRefreshToken } from '../../domain/refresh-token';
import type { Session } from '../../domain/session';

export class InMemoryUserRepository implements UserRepository {
  private readonly credentials = new Map<string, StoredCredentials>();
  /** Every handle this repository was asked about, in order. */
  readonly lookups: string[] = [];

  seed(handle: string, credentials: StoredCredentials): void {
    this.credentials.set(handle.toLowerCase(), credentials);
  }

  existsByHandle(handle: string): Promise<boolean> {
    return Promise.resolve(this.credentials.has(handle.toLowerCase()));
  }

  create(): Promise<void> {
    return Promise.reject(new Error('not used by LoginUseCase'));
  }

  findCredentialsByHandle(handle: string): Promise<StoredCredentials | undefined> {
    this.lookups.push(handle);
    // Case-insensitive because CITEXT makes the real query so.
    return Promise.resolve(this.credentials.get(handle.toLowerCase()));
  }
}

/** Rows are replaced, never mutated, so a read stays a snapshot — as stale as a real SELECT under concurrency. */
export class InMemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, Session>();
  readonly tokens = new Map<string, StoredRefreshToken>();

  create(session: Session, firstToken: StoredRefreshToken): Promise<void> {
    this.sessions.set(session.id, session);
    this.tokens.set(firstToken.id, firstToken);
    return Promise.resolve();
  }

  findByTokenHash(tokenHash: string): Promise<SessionWithToken | undefined> {
    const token = [...this.tokens.values()].find((row) => row.tokenHash === tokenHash);
    const session = token === undefined ? undefined : this.sessions.get(token.sessionId);
    return Promise.resolve(
      token === undefined || session === undefined ? undefined : { session, token },
    );
  }

  // Check and write in one synchronous step: the in-memory equivalent of a conditional UPDATE.
  rotate(spentTokenId: string, next: StoredRefreshToken, spentAt: Date): Promise<boolean> {
    const current = this.tokens.get(spentTokenId);
    const session = current === undefined ? undefined : this.sessions.get(current.sessionId);
    if (current === undefined || current.spentAt !== null || session?.revokedAt !== null) {
      return Promise.resolve(false);
    }

    this.tokens.set(spentTokenId, { ...current, spentAt });
    this.tokens.set(next.id, next);
    return Promise.resolve(true);
  }

  revoke(sessionId: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined && session.revokedAt === null) {
      this.sessions.set(sessionId, { ...session, revokedAt });
    }
    return Promise.resolve();
  }
}

/** Records every call, so a test can assert on work that must not be skipped. */
export class FakePasswordHasher implements PasswordHasher {
  readonly hashed: string[] = [];
  readonly verified: { hash: string; password: string }[] = [];

  hash(password: string): Promise<string> {
    this.hashed.push(password);
    return Promise.resolve(`hashed:${password}`);
  }

  verify(hash: string, password: string): Promise<boolean> {
    this.verified.push({ hash, password });
    return Promise.resolve(hash === `hashed:${password}`);
  }
}

export class FakeAccessTokenIssuer implements AccessTokenIssuer {
  readonly issued: AccessTokenClaims[] = [];

  issue(claims: AccessTokenClaims): string {
    this.issued.push(claims);
    return `access:${claims.userId}:${claims.sessionId}:${this.issued.length.toString()}`;
  }
}

/** Predictable tokens with a real digest: a `sha256:<token>` fake would contain the token it hides. */
export class FakeRefreshTokenFactory implements RefreshTokenFactory {
  #next = 0;

  create(): RefreshToken {
    this.#next += 1;
    const token = `opaque-${this.#next.toString()}`;
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

export class FakeIdGenerator implements IdGenerator {
  #next = 0;

  next(): string {
    this.#next += 1;
    return this.#next.toString();
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
