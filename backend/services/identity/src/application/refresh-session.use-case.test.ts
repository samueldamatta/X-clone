import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidRefreshTokenError } from '../domain/errors';
import { LoginUseCase } from './login.use-case';
import { RefreshSessionUseCase } from './refresh-session.use-case';
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
  const issuer = new FakeAccessTokenIssuer();
  const refreshTokens = new FakeRefreshTokenFactory();
  const ids = new FakeIdGenerator();
  const clock = new FixedClock(NOW);
  const lifetimes = { accessTokenMs: ACCESS_TTL_MS, refreshTokenMs: REFRESH_TTL_MS };

  const login = new LoginUseCase(
    users,
    sessions,
    new FakePasswordHasher(),
    issuer,
    refreshTokens,
    ids,
    clock,
    lifetimes,
  );
  const refresh = new RefreshSessionUseCase(sessions, issuer, refreshTokens, ids, clock, lifetimes);

  users.seed('sam', { userId: '900', passwordHash: 'hashed:correcthorse1' });

  // Sessions come from real logins rather than seeded rows, so every fixture is one the system can produce.
  const logIn = () => login.execute({ handle: 'sam', password: 'correcthorse1' });

  return { issuer, clock, refresh, logIn };
}

describe('RefreshSessionUseCase', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('exchanges a valid refresh token for a new pair on the same session', async () => {
    const loggedIn = await ctx.logIn();
    ctx.clock.advance(20 * 60 * 1000);
    const refreshedAt = ctx.clock.now();

    const result = await ctx.refresh.execute({ refreshToken: loggedIn.refreshToken });

    expect(result).toEqual({
      userId: '900',
      sessionId: loggedIn.sessionId,
      accessToken: 'access:900:1:2',
      accessTokenExpiresAt: new Date(refreshedAt.getTime() + ACCESS_TTL_MS),
      refreshToken: 'opaque-2',
      // Absolute: still 30 days from the login, not from this refresh.
      refreshTokenExpiresAt: new Date(NOW.getTime() + REFRESH_TTL_MS),
    });
  });

  it('refuses a refresh token that has already been exchanged', async () => {
    const loggedIn = await ctx.logIn();
    await ctx.refresh.execute({ refreshToken: loggedIn.refreshToken });

    await expect(ctx.refresh.execute({ refreshToken: loggedIn.refreshToken })).rejects.toThrow(
      InvalidRefreshTokenError,
    );
  });

  // The legitimate holder and a thief cannot both hold a spent token honestly, so replaying one kills the chain.
  it('revokes the whole chain when a spent token is replayed, newest token included', async () => {
    const a = await ctx.logIn();
    const b = await ctx.refresh.execute({ refreshToken: a.refreshToken });
    const c = await ctx.refresh.execute({ refreshToken: b.refreshToken });

    await expect(ctx.refresh.execute({ refreshToken: a.refreshToken })).rejects.toThrow(
      InvalidRefreshTokenError,
    );

    await expect(ctx.refresh.execute({ refreshToken: c.refreshToken })).rejects.toThrow(
      InvalidRefreshTokenError,
    );
  });

  it('leaves the account’s other sessions working after one chain is revoked', async () => {
    const laptop = await ctx.logIn();
    const phone = await ctx.logIn();
    await ctx.refresh.execute({ refreshToken: laptop.refreshToken });
    await ctx.refresh.execute({ refreshToken: laptop.refreshToken }).catch(() => undefined);

    const result = await ctx.refresh.execute({ refreshToken: phone.refreshToken });

    expect(result.sessionId).toBe(phone.sessionId);
  });

  it('refuses an unspent token once the session’s absolute lifetime is over', async () => {
    const a = await ctx.logIn();
    ctx.clock.advance(REFRESH_TTL_MS - 1000);
    const b = await ctx.refresh.execute({ refreshToken: a.refreshToken });
    ctx.clock.advance(1000);

    await expect(ctx.refresh.execute({ refreshToken: b.refreshToken })).rejects.toThrow(
      InvalidRefreshTokenError,
    );
  });

  // Both requests read the token as unspent; only the conditional write can tell them apart.
  it('lets exactly one of two concurrent exchanges win, then treats the loser as reuse', async () => {
    const a = await ctx.logIn();

    const outcomes = await Promise.allSettled([
      ctx.refresh.execute({ refreshToken: a.refreshToken }),
      ctx.refresh.execute({ refreshToken: a.refreshToken }),
    ]);

    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')?.reason).toBeInstanceOf(
      InvalidRefreshTokenError,
    );

    const [winner] = winners;
    await expect(
      ctx.refresh.execute({ refreshToken: winner?.value.refreshToken ?? '' }),
    ).rejects.toThrow(InvalidRefreshTokenError);
  });

  it('refuses a token it never issued', async () => {
    await ctx.logIn();

    await expect(ctx.refresh.execute({ refreshToken: 'opaque-999' })).rejects.toThrow(
      InvalidRefreshTokenError,
    );
  });
});
