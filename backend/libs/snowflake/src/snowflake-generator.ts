import { SnowflakeClockError, SnowflakeConfigurationError } from './errors';
import { NODE_ID_BITS, assertValidNodeId } from './node-id';

/**
 * Milliseconds since the Unix epoch at 2026-01-01T00:00:00.000Z, the instant
 * this project counts from.
 *
 * A custom epoch buys back the years a Unix-epoch count would already have
 * spent: 41 bits is ~69 years, so counting from 2026 runs to 2095 rather than
 * expiring in 2039. It is not configurable, and that is deliberate — every id
 * already issued decodes against this number, so moving it would reorder them.
 */
export const SNOWFLAKE_EPOCH_MS = 1_767_225_600_000;

const SEQUENCE_BITS = 12n;

/** 4095. `sequence & MAX_SEQUENCE` wraps to 0 instead of overflowing into the node id bits. */
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

export interface SnowflakeGeneratorOptions {
  /** Unique per running instance, not per service. */
  nodeId: number;
  /** Defaults to `Date.now`. Exists so a test can hold a millisecond still. */
  clock?: () => number;
}

export class SnowflakeGenerator {
  readonly #nodeId: bigint;
  readonly #clock: () => number;

  #lastTimestamp = -1n;
  #sequence = 0n;

  constructor(options: SnowflakeGeneratorOptions) {
    assertValidNodeId(options.nodeId);

    this.#clock = options.clock ?? Date.now;

    // A clock behind the epoch encodes a negative timestamp: ids below zero,
    // ordering inverted, and a BIGINT column that accepts them without
    // complaint. Checked here so a misconfigured host fails at boot.
    const now = this.#clock();
    if (now < SNOWFLAKE_EPOCH_MS) {
      throw new SnowflakeConfigurationError(
        `This host's clock reads ${new Date(now).toISOString()}, which is before the Snowflake ` +
          `epoch of ${new Date(SNOWFLAKE_EPOCH_MS).toISOString()}. Check the system clock.`,
      );
    }

    this.#nodeId = BigInt(options.nodeId);
  }

  /**
   * Returns the id as a decimal string, never a number: a 64-bit value is
   * above `Number.MAX_SAFE_INTEGER`, so a JavaScript number would silently
   * round it.
   */
  next(): string {
    let timestamp = BigInt(this.#clock() - SNOWFLAKE_EPOCH_MS);

    if (timestamp < this.#lastTimestamp) {
      throw new SnowflakeClockError(this.#lastTimestamp - timestamp);
    }

    if (timestamp === this.#lastTimestamp) {
      this.#sequence = (this.#sequence + 1n) & MAX_SEQUENCE;
      if (this.#sequence === 0n) {
        // All 4096 slots for this millisecond are spent. Spinning until the
        // clock moves is the only correct answer: returning anything now would
        // repeat an id already issued.
        timestamp = this.#waitForNextMillisecond(timestamp);
      }
    } else {
      this.#sequence = 0n;
    }

    this.#lastTimestamp = timestamp;

    const id =
      (timestamp << (NODE_ID_BITS + SEQUENCE_BITS)) |
      (this.#nodeId << SEQUENCE_BITS) |
      this.#sequence;

    return id.toString();
  }

  /**
   * Busy-waits. It blocks the event loop, which is a real cost on a
   * single-threaded runtime — but it is bounded by how much of the current
   * millisecond is left, and reaching it at all means this instance is minting
   * more than 4,096 ids in one millisecond.
   */
  #waitForNextMillisecond(current: bigint): bigint {
    let timestamp = current;
    while (timestamp <= current) {
      timestamp = BigInt(this.#clock() - SNOWFLAKE_EPOCH_MS);
    }
    return timestamp;
  }
}
