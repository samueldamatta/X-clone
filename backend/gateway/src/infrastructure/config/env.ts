export interface GatewayConfig {
  /** The one port in this system a browser ever connects to. */
  httpPort: number;
  /** host:port of the Identity gRPC server. */
  identityGrpcUrl: string;
  /**
   * The HS256 key Identity signs access tokens with. The Gateway holds it
   * to *verify* them, locally, with no call back — which is the whole
   * reason the access token is a JWT.
   *
   * A shared secret means whoever can verify can also mint: a compromised
   * Gateway can forge a token for any account. Asymmetric keys would have
   * prevented exactly that, at the price of distributing a public key
   * (JWKS, or a second variable to keep in step). Identity's own env.ts
   * carries the same note, and the day a third service needs to verify is
   * the day to revisit it.
   */
  jwtSecret: string;
}

/**
 * Read once, at boot — same reasoning as the Identity service's own loader.
 *
 * The port and the Identity address have correct local defaults and stay
 * optional. JWT_SECRET does not, and it is the first thing this service has
 * ever required: a default signing key is the one default worse than a
 * crash, because it works, so nobody notices, and it would be published in
 * this repository for anyone to forge tokens with. Failing here — before
 * the HTTP server binds — is the only cheap place to find out it is missing.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  return {
    httpPort: readPort(env, 'PORT', 8080),
    identityGrpcUrl: env.IDENTITY_GRPC_URL?.trim() || 'localhost:8081',
    jwtSecret: requireEnv(env, 'JWT_SECRET'),
  };
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${key} is not set.`);
  }
  return value;
}

function readPort(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} must be an integer between 1 and 65535, got "${raw}".`);
  }
  return port;
}
