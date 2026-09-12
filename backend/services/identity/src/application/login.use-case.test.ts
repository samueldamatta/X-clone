import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidCredentialsError } from '../domain/errors';
import type { AccessTokenClaims, AccessTokenIssuer } from '../domain/ports/access-token-issuer';
import type { Clock } from '../domain/ports/clock';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { PasswordHasher } from '../domain/ports/password-hasher';
import type { RefreshToken, RefreshTokenFactory } from '../domain/ports/refresh-token-factory';
import type { SessionRepository } from '../domain/ports/session-repository';
import type { StoredCredentials, UserRepository } from '../domain/ports/user-repository';
import type { Session } from '../domain/session';
import { LoginUseCase } from './login.use-case';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-11T12:00:00.000Z');

class InMemoryUserRepository implements UserRepository {
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
    // Case-insensitive here because CITEXT makes the real query so — a fake
    // that matched case-sensitively would let a bug through that production
    // does not have.
    return Promise.resolve(this.credentials.get(handle.toLowerCase()));
  }
}

class InMemorySessionRepository implements SessionRepository {
  readonly created: Session[] = [];

  create(session: Session): Promise<void> {
    this.created.push(session);
    return Promise.resolve();
  }
}

/**
 * Records every call, because what this use case must *not* skip is as
 * much of its behaviour as what it returns.
 */
class FakePasswordHasher implements PasswordHasher {
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

class FakeAccessTokenIssuer implements AccessTokenIssuer {
  readonly issued: AccessTokenClaims[] = [];

  issue(claims: AccessTokenClaims): string {
    this.issued.push(claims);
    return `access:${claims.userId}:${claims.sessionId}`;
  }
}

/**
 * Predictable tokens, but a real digest of them. A fake that returned
 * `sha256:<token>` would be readable and useless: the "nothing stores the
 * token" test would fail against a correct implementation, because the
 * token is a substring of that hash.
 */
class FakeRefreshTokenFactory implements RefreshTokenFactory {
  #next = 0;

  static hashOf(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  create(): RefreshToken {
    this.#next += 1;
    const token = `opaque-${this.#next.toString()}`;
    return { token, hash: FakeRefreshTokenFactory.hashOf(token) };
  }
}

class FakeIdGenerator implements IdGenerator {
  #next = 0;

  next(): string {
    this.#next += 1;
    return this.#next.toString();
  }
}

class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function setup() {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const hasher = new FakePasswordHasher();
  const issuer = new FakeAccessTokenIssuer();
  const refreshTokens = new FakeRefreshTokenFactory();
  const ids = new FakeIdGenerator();
  const clock = new FixedClock(NOW);

  const useCase = new LoginUseCase(users, sessions, hasher, issuer, refreshTokens, ids, clock, {
    accessTokenMs: ACCESS_TTL_MS,
    refreshTokenMs: REFRESH_TTL_MS,
  });

  users.seed('sam', { userId: '900', passwordHash: 'hashed:correcthorse1' });

  return { users, sessions, hasher, issuer, refreshTokens, ids, clock, useCase };
}

describe('LoginUseCase', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('returns both tokens and opens a session for valid credentials', async () => {
    const result = await ctx.useCase.execute({
      handle: 'sam',
      password: 'correcthorse1',
      userAgent: 'curl/8.4.0',
    });

    expect(result).toEqual({
      userId: '900',
      sessionId: '1',
      accessToken: 'access:900:1',
      accessTokenExpiresAt: new Date(NOW.getTime() + ACCESS_TTL_MS),
      refreshToken: 'opaque-1',
      refreshTokenExpiresAt: new Date(NOW.getTime() + REFRESH_TTL_MS),
    });

    expect(ctx.sessions.created).toEqual([
      {
        id: '1',
        userId: '900',
        refreshTokenHash: FakeRefreshTokenFactory.hashOf('opaque-1'),
        expiresAt: new Date(NOW.getTime() + REFRESH_TTL_MS),
        revokedAt: null,
        userAgent: 'curl/8.4.0',
        createdAt: NOW,
      },
    ]);
  });

  it('stores the refresh token only as a hash', async () => {
    const result = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    const [session] = ctx.sessions.created;
    // The whole row, not just the hash column: the token must not have been
    // parked in user_agent or anywhere else on the way past.
    expect(JSON.stringify(session)).not.toContain(result.refreshToken);
  });

  it('mints the access token against this session, not just the account', async () => {
    await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    expect(ctx.issuer.issued).toEqual([
      {
        userId: '900',
        sessionId: '1',
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + ACCESS_TTL_MS),
      },
    ]);
  });

  it('finds the account whatever the case of the handle', async () => {
    const result = await ctx.useCase.execute({ handle: 'SAM', password: 'correcthorse1' });

    expect(result.userId).toBe('900');
  });

  it('rejects a wrong password without opening a session', async () => {
    await expect(ctx.useCase.execute({ handle: 'sam', password: 'wrong-one1' })).rejects.toThrow(
      InvalidCredentialsError,
    );

    expect(ctx.sessions.created).toEqual([]);
    expect(ctx.issuer.issued).toEqual([]);
  });

  it('rejects an unknown handle without opening a session', async () => {
    await expect(
      ctx.useCase.execute({ handle: 'nobody', password: 'correcthorse1' }),
    ).rejects.toThrow(InvalidCredentialsError);

    expect(ctx.sessions.created).toEqual([]);
    expect(ctx.issuer.issued).toEqual([]);
  });

  /**
   * The acceptance criterion, as a test the implementation cannot satisfy
   * by accident: the two rejections must be indistinguishable to the
   * caller. Same type, same message, and nothing on the instance that
   * separates them.
   */
  it('fails identically for an unknown handle and a wrong password', async () => {
    const unknownHandle = await ctx.useCase
      .execute({ handle: 'nobody', password: 'correcthorse1' })
      .catch((error: unknown) => error);
    const wrongPassword = await ctx.useCase
      .execute({ handle: 'sam', password: 'wrong-one1' })
      .catch((error: unknown) => error);

    expect(unknownHandle).toBeInstanceOf(InvalidCredentialsError);
    expect(wrongPassword).toBeInstanceOf(InvalidCredentialsError);
    expect((unknownHandle as Error).message).toBe((wrongPassword as Error).message);
    expect(Object.keys(unknownHandle as object)).toEqual(Object.keys(wrongPassword as object));
  });

  /**
   * Indistinguishable in content is only half of it. An unknown handle that
   * returns without hashing anything comes back in microseconds, while a
   * wrong password pays for an argon2id verify (~100ms, by design) — and
   * that difference is a perfectly good answer to "does this handle exist?"
   * for anyone holding a stopwatch.
   */
  it('spends a password hash even when the handle does not exist', async () => {
    await expect(
      ctx.useCase.execute({ handle: 'nobody', password: 'correcthorse1' }),
    ).rejects.toThrow(InvalidCredentialsError);

    expect(ctx.hasher.hashed).toEqual(['correcthorse1']);
  });

  it('opens two independent sessions when the same account logs in twice', async () => {
    const first = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });
    ctx.clock.advance(1000);
    const second = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);

    expect(ctx.sessions.created).toHaveLength(2);
    // Both live. Logging in on a phone must not sign you out on a laptop —
    // #9's logout is scoped to one session precisely because of this.
    expect(ctx.sessions.created.map((session) => session.revokedAt)).toEqual([null, null]);
  });

  it('dates each session from the clock, not from whenever the test runs', async () => {
    ctx.clock.advance(90 * 60 * 1000);
    const result = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    const expected = new Date(NOW.getTime() + 90 * 60 * 1000);
    expect(ctx.sessions.created[0]?.createdAt).toEqual(expected);
    expect(result.accessTokenExpiresAt).toEqual(new Date(expected.getTime() + ACCESS_TTL_MS));
  });

  it('records no user agent when the client sent none', async () => {
    await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    expect(ctx.sessions.created[0]?.userAgent).toBeNull();
  });

  /**
   * Register validates; login does not. A handle too short to be valid is
   * simply a handle no account has, and answering 400 for it while
   * answering 401 for an unknown-but-well-formed one hands back exactly the
   * distinction InvalidCredentialsError exists to hide.
   */
  it('answers a malformed handle the same way as any other unknown one', async () => {
    const malformed = await ctx.useCase
      .execute({ handle: 'a', password: 'correcthorse1' })
      .catch((error: unknown) => error);

    expect(malformed).toBeInstanceOf(InvalidCredentialsError);
  });

  it('answers a password too weak to have been registered the same way', async () => {
    const weak = await ctx.useCase
      .execute({ handle: 'sam', password: 'abc' })
      .catch((error: unknown) => error);

    expect(weak).toBeInstanceOf(InvalidCredentialsError);
  });
});
