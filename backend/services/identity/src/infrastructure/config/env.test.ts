import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

const REQUIRED = {
  DATABASE_URL: 'postgres://identity_svc:pw@localhost:5432/xclone',
  JWT_SECRET: 'a'.repeat(32),
  SNOWFLAKE_NODE_ID: '1',
};

describe('loadConfig', () => {
  it('reads every value, falling back to the documented local defaults', () => {
    expect(loadConfig(REQUIRED)).toEqual({
      databaseUrl: REQUIRED.DATABASE_URL,
      grpcUrl: '0.0.0.0:8081',
      snowflakeNodeId: 1,
      jwtSecret: REQUIRED.JWT_SECRET,
      tokenLifetimes: {
        accessTokenMs: 15 * 60 * 1000,
        refreshTokenMs: 30 * 24 * 60 * 60 * 1000,
      },
    });
  });

  /**
   * The lifetime docs/04-api-contracts.md publishes, asserted here so the
   * contract and the code cannot drift apart quietly. If this number has to
   * change, the failing test is the reminder to change the document too.
   */
  it('issues access tokens that live fifteen minutes', () => {
    expect(loadConfig(REQUIRED).tokenLifetimes.accessTokenMs).toBe(900_000);
  });

  it('reads the gRPC bind address from the environment', () => {
    expect(loadConfig({ ...REQUIRED, GRPC_URL: 'identity:9999' }).grpcUrl).toBe('identity:9999');
  });

  /**
   * The one default that would be worse than a crash. A service that boots
   * with a fallback signing key works perfectly, tells nobody, and signs
   * tokens anyone reading this repository could forge.
   */
  it('refuses to start without a JWT secret', () => {
    expect(() => loadConfig(without('JWT_SECRET'))).toThrow(/JWT_SECRET is not set/);
  });

  it('treats a blank JWT secret as absent rather than as an empty key', () => {
    expect(() => loadConfig({ ...REQUIRED, JWT_SECRET: '   ' })).toThrow(/JWT_SECRET is not set/);
  });

  it('still refuses to start without a database url', () => {
    expect(() => loadConfig(without('DATABASE_URL'))).toThrow(/DATABASE_URL is not set/);
  });
});

function without(key: keyof typeof REQUIRED): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...REQUIRED };
  delete env[key];
  return env;
}
