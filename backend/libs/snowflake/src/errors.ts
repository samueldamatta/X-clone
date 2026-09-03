/**
 * The clock moved backwards, so the generator would re-enter milliseconds whose
 * sequence it has already spent.
 *
 * There is no safe way to continue. Waiting out the drift sounds kinder but
 * hides an operational fault — a host whose clock jumps is a host that will do
 * it again — and the wait is unbounded, so the caller blocks with no signal.
 * Throwing surfaces it where it can be seen.
 */
export class SnowflakeClockError extends Error {
  constructor(driftMs: bigint) {
    super(
      `Clock moved backwards by ${driftMs.toString()} ms; refusing to issue an id that may already exist. ` +
        'Check NTP on this host.',
    );
    this.name = 'SnowflakeClockError';
  }
}

/**
 * The node id this instance was given cannot produce unique identifiers.
 *
 * Thrown at construction, which is at process start, because the alternative is
 * discovering it as a duplicate key on live data hours later.
 */
export class SnowflakeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnowflakeConfigurationError';
  }
}
