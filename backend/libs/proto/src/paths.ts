import { join } from 'node:path';

/**
 * Absolute path to identity.proto, for @grpc/proto-loader on either side of
 * the call. Resolved from this compiled file's own location (dist/), not
 * from process.cwd(), so it works the same whether the caller runs from the
 * service root or a test runner's temp dir.
 */
export function identityProtoPath(): string {
  return join(__dirname, 'identity', 'v1', 'identity.proto');
}
