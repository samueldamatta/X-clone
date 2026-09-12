import { nodeIdFromEnv } from '@x-clone/snowflake';
import type { TokenLifetimes } from '../../application/login.use-case';

/**
 * Fifteen minutes, and the number docs/04-api-contracts.md publishes. It is
 * the window during which a stolen access token still works, because
 * nothing can revoke a JWT before it expires — that is the price of the
 * Gateway being able to verify one without a network hop.
 *
 * Deliberately a constant rather than an environment variable. An operator
 * who can set it to 24h turns the published contract into a lie that no
 * test would catch, and this repository would rather pay a redeploy to
 * change it than let the documentation drift.
 */
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Thirty days. Long because the whole point of the split is that the
 * long-lived half is revocable: a refresh token is a row, and #9's logout
 * is an UPDATE on it. Its length costs nothing the session table cannot
 * take back.
 */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IdentityConfig {
  /** identity_svc connection string — never the postgres superuser's. */
  databaseUrl: string;
  /** host:port the gRPC server binds to. */
  grpcUrl: string;
  snowflakeNodeId: number;
  /**
   * The HS256 signing key, shared with the Gateway so it can verify
   * locally. Shared-secret rather than a public/private pair, which has a
   * real cost: whoever can verify can also mint. A compromised Gateway can
   * forge a token for any account, and asymmetric keys would have prevented
   * exactly that — at the price of distributing a public key (JWKS, or a
   * second env var to keep in step). Revisit when a third service needs to
   * verify.
   */
  jwtSecret: string;
  tokenLifetimes: TokenLifetimes;
}

/**
 * Read once, at boot. Failing here — before the gRPC server binds — is the
 * only place a misconfigured host is cheap; the alternative is a service
 * that starts, looks healthy, and fails the first request it receives.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): IdentityConfig {
  return {
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    grpcUrl: env.GRPC_URL?.trim() || '0.0.0.0:8081',
    snowflakeNodeId: nodeIdFromEnv(env),
    // Required, with no fallback. A default signing key is the one default
    // that is worse than a crash: it works, so nobody notices, and it is
    // published in this repository for anyone to sign tokens with.
    jwtSecret: requireEnv(env, 'JWT_SECRET'),
    tokenLifetimes: {
      accessTokenMs: ACCESS_TOKEN_TTL_MS,
      refreshTokenMs: REFRESH_TOKEN_TTL_MS,
    },
  };
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${key} is not set.`);
  }
  return value;
}
