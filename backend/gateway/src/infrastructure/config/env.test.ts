import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

describe('loadConfig', () => {
  it('falls back to the documented local defaults', () => {
    expect(loadConfig({})).toEqual({
      httpPort: 8080,
      identityGrpcUrl: 'localhost:8081',
    });
  });

  it('reads both values from the environment', () => {
    expect(loadConfig({ PORT: '9090', IDENTITY_GRPC_URL: 'identity:8081' })).toEqual({
      httpPort: 9090,
      identityGrpcUrl: 'identity:8081',
    });
  });

  it('treats a blank value as absent rather than as a parse failure', () => {
    expect(loadConfig({ PORT: '  ', IDENTITY_GRPC_URL: '' }).httpPort).toBe(8080);
  });

  it('refuses a port that is not a usable integer', () => {
    // Number('http://x') is NaN, and listen(NaN) binds a random free port —
    // a service that starts, looks healthy, and is reachable at no address
    // anyone configured.
    expect(() => loadConfig({ PORT: 'http://x' })).toThrow(/PORT must be an integer/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT must be an integer/);
  });
});
