import { nodeIdFromEnv } from '@x-clone/snowflake';

export interface IdentityConfig {
  /** identity_svc connection string — never the postgres superuser's. */
  databaseUrl: string;
  /** host:port the gRPC server binds to. */
  grpcUrl: string;
  snowflakeNodeId: number;
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
  };
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${key} is not set.`);
  }
  return value;
}
