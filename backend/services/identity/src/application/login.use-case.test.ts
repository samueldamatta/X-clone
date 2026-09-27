import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidCredentialsError } from '../domain/errors';
import { LoginUseCase } from './login.use-case';
import {
  FakeAccessTokenIssuer,
  FakeIdGenerator,
  FakePasswordHasher,
  FakeRefreshTokenFactory,
  FixedClock,
  InMemorySessionRepository,
  InMemoryUserRepository,
} from './testing/fakes';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-11T12:00:00.000Z');

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
      accessToken: 'access:900:1:1',
      accessTokenExpiresAt: new Date(NOW.getTime() + ACCESS_TTL_MS),
      refreshToken: 'opaque-1',
      refreshTokenExpiresAt: new Date(NOW.getTime() + REFRESH_TTL_MS),
    });

    expect([...ctx.sessions.sessions.values()]).toEqual([
      {
        id: '1',
        userId: '900',
        expiresAt: new Date(NOW.getTime() + REFRESH_TTL_MS),
        revokedAt: null,
        userAgent: 'curl/8.4.0',
        createdAt: NOW,
      },
    ]);
    expect([...ctx.sessions.tokens.values()]).toEqual([
      {
        id: '2',
        sessionId: '1',
        tokenHash: ctx.refreshTokens.hash('opaque-1'),
        spentAt: null,
        createdAt: NOW,
      },
    ]);
  });

  it('stores the refresh token only as a hash', async () => {
    const result = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    // Every row, not just the hash column: a token parked in user_agent is just as leaked.
    const stored = JSON.stringify([
      ...ctx.sessions.sessions.values(),
      ...ctx.sessions.tokens.values(),
    ]);
    expect(stored).not.toContain(result.refreshToken);
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

    expect(ctx.sessions.sessions.size).toBe(0);
    expect(ctx.issuer.issued).toEqual([]);
  });

  it('rejects an unknown handle without opening a session', async () => {
    await expect(
      ctx.useCase.execute({ handle: 'nobody', password: 'correcthorse1' }),
    ).rejects.toThrow(InvalidCredentialsError);

    expect(ctx.sessions.sessions.size).toBe(0);
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

    const [firstClaims, secondClaims] = ctx.issuer.issued;
    expect(secondClaims?.sessionId).not.toBe(firstClaims?.sessionId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.accessToken).not.toBe(first.accessToken);

    const sessions = [...ctx.sessions.sessions.values()];
    expect(sessions).toHaveLength(2);
    // Both live. Logging in on a phone must not sign you out on a laptop —
    // #9's logout is scoped to one session precisely because of this.
    expect(sessions.map((session) => session.revokedAt)).toEqual([null, null]);
  });

  it('dates each session from the clock, not from whenever the test runs', async () => {
    ctx.clock.advance(90 * 60 * 1000);
    const result = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    const expected = new Date(NOW.getTime() + 90 * 60 * 1000);
    expect(ctx.sessions.sessions.get('1')?.createdAt).toEqual(expected);
    expect(result.accessTokenExpiresAt).toEqual(new Date(expected.getTime() + ACCESS_TTL_MS));
  });

  it('records no user agent when the client sent none', async () => {
    await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    expect(ctx.sessions.sessions.get('1')?.userAgent).toBeNull();
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
