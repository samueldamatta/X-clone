import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

/** The compose value, so the test and the environment agree on the shape. */
const SECRET = 'dev-only-not-a-secret-change-me-32b';

describe('loadConfig', () => {
  it('falls back to the documented local defaults', () => {
    expect(loadConfig({ JWT_SECRET: SECRET })).toEqual({
      httpPort: 8080,
      identityGrpcUrl: 'localhost:8081',
      jwtSecret: SECRET,
    });
  });

  it('reads every value from the environment', () => {
    expect(
      loadConfig({ PORT: '9090', IDENTITY_GRPC_URL: 'identity:8081', JWT_SECRET: SECRET }),
    ).toEqual({
      httpPort: 9090,
      identityGrpcUrl: 'identity:8081',
      jwtSecret: SECRET,
    });
  });

  it('treats a blank value as absent rather than as a parse failure', () => {
    expect(loadConfig({ PORT: '  ', IDENTITY_GRPC_URL: '', JWT_SECRET: SECRET }).httpPort).toBe(
      8080,
    );
  });

  it('refuses to start without a signing key', () => {
    // The first thing this service has ever required. A default here would
    // work, which is what makes it worse than a crash: it would be this
    // repository's published key, and anyone could sign a token with it.
    expect(() => loadConfig({})).toThrow(/JWT_SECRET is not set/);
    expect(() => loadConfig({ JWT_SECRET: '   ' })).toThrow(/JWT_SECRET is not set/);
  });

  it('refuses a port that is not a usable integer', () => {
    // Number('http://x') is NaN, and listen(NaN) binds a random free port —
    // a service that starts, looks healthy, and is reachable at no address
    // anyone configured.
    expect(() => loadConfig({ PORT: 'http://x', JWT_SECRET: SECRET })).toThrow(
      /PORT must be an integer/,
    );
    expect(() => loadConfig({ PORT: '70000', JWT_SECRET: SECRET })).toThrow(
      /PORT must be an integer/,
    );
  });
});
