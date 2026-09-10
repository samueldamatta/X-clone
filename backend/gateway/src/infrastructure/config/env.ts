export interface GatewayConfig {
  /** The one port in this system a browser ever connects to. */
  httpPort: number;
  /** host:port of the Identity gRPC server. */
  identityGrpcUrl: string;
}

/**
 * Read once, at boot — same reasoning as the Identity service's own loader.
 * Unlike Identity, nothing here is mandatory: the Gateway holds no
 * credentials of its own, and both values have a correct local default.
 * A wrong port still fails loudly rather than being coerced to NaN and
 * binding somewhere unpredictable.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  return {
    httpPort: readPort(env, 'PORT', 8080),
    identityGrpcUrl: env.IDENTITY_GRPC_URL?.trim() || 'localhost:8081',
  };
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
