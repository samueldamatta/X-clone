import { SnowflakeConfigurationError } from './errors';

/** Ten bits of node id, so 1,024 instances can mint concurrently. */
export const NODE_ID_BITS = 10n;

/** 1023 — the largest node id those ten bits can hold. */
export const MAX_NODE_ID = Number((1n << NODE_ID_BITS) - 1n);

/** The variable every service reads its node id from. */
export const NODE_ID_ENV_VAR = 'SNOWFLAKE_NODE_ID';

/**
 * Throws unless `nodeId` is an integer this generator can encode. A node id
 * outside the range silently overlaps another instance's, which is the one
 * failure that produces duplicate ids with no error anywhere.
 */
export function assertValidNodeId(nodeId: number, source = 'node id'): void {
  if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > MAX_NODE_ID) {
    throw new SnowflakeConfigurationError(
      `${source} must be an integer between 0 and ${MAX_NODE_ID.toString()}, got ${String(nodeId)}.`,
    );
  }
}

/**
 * Reads and validates this instance's node id, throwing if it cannot.
 *
 * Call it from a service's entry point, before anything is wired. The node id
 * must be unique per *running instance* — two replicas of the same service
 * sharing one mint colliding ids under load — and nothing at runtime can detect
 * that. Refusing to boot is the only place the problem is cheap.
 */
export function nodeIdFromEnv(
  env: Record<string, string | undefined>,
  variable: string = NODE_ID_ENV_VAR,
): number {
  const raw = env[variable];

  if (raw === undefined || raw.trim() === '') {
    throw new SnowflakeConfigurationError(
      `${variable} is not set. It must be an integer between 0 and ${MAX_NODE_ID.toString()}, ` +
        'unique across every running instance of every service.',
    );
  }

  // `Number` accepts '1e3', '0x10' and ' 12 '; none of those is a node id
  // anyone meant to write, and all three would pass a looser check.
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new SnowflakeConfigurationError(
      `${variable} must be an integer between 0 and ${MAX_NODE_ID.toString()}, got "${raw}".`,
    );
  }

  const nodeId = Number(raw.trim());
  assertValidNodeId(nodeId, variable);

  return nodeId;
}
