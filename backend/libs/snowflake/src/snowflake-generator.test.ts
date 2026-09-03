import { describe, expect, it } from 'vitest';

import { SnowflakeClockError, SnowflakeConfigurationError } from './errors';
import { SNOWFLAKE_EPOCH_MS, SnowflakeGenerator } from './snowflake-generator';

/**
 * A clock that stands still for `readsPerTick` reads and then moves forward one
 * millisecond — which is what a real clock does to a process spinning inside a
 * single millisecond.
 *
 * The clock is a constructor argument precisely so this is possible. `Date.now`
 * cannot be asked to stand still, and standing still is the only condition
 * under which the guarantees below mean anything.
 *
 * Note that the constructor reads the clock once, to reject a host whose clock
 * predates the epoch — so read `n` of this counter is generator call `n - 1`.
 */
function clockTickingEvery(readsPerTick: number, startMs = SNOWFLAKE_EPOCH_MS): () => number {
  let reads = 0;
  return () => startMs + Math.floor(reads++ / readsPerTick);
}

describe('SnowflakeGenerator', () => {
  it('issues ids that always increase, so sorting by id sorts by time', () => {
    const generator = new SnowflakeGenerator({ nodeId: 7, clock: clockTickingEvery(1) });

    const ids = [generator.next(), generator.next(), generator.next()];

    expect(BigInt(ids[1]!)).toBeGreaterThan(BigInt(ids[0]!));
    expect(BigInt(ids[2]!)).toBeGreaterThan(BigInt(ids[1]!));
  });

  // 4096 is the whole sequence space for one millisecond. A burst larger than
  // that is the condition no HTTP test can provoke, and the only one under
  // which the generator can produce a duplicate.
  it('yields no duplicates when a burst exhausts the per-millisecond sequence', () => {
    const burst = 5_000;
    const generator = new SnowflakeGenerator({ nodeId: 7, clock: clockTickingEvery(burst) });

    const ids = Array.from({ length: burst }, () => generator.next());

    expect(new Set(ids).size).toBe(burst);
  });

  // An NTP correction that steps the clock backwards puts the generator back
  // onto milliseconds whose sequence it has already spent. Failing loudly is
  // the cheaper of the two outcomes; the other is duplicate ids nobody notices.
  it('refuses to issue an id when the clock moves backwards', () => {
    let now = SNOWFLAKE_EPOCH_MS + 10_000;
    const generator = new SnowflakeGenerator({ nodeId: 7, clock: () => now });
    generator.next();

    now -= 50;

    expect(() => generator.next()).toThrow(SnowflakeClockError);
    expect(() => generator.next()).toThrow(/50 ms/);
  });

  // 10 bits is 0..1023. A node id outside it silently overlaps another
  // instance's range, which is the one failure that produces duplicate ids
  // with no error anywhere.
  it.each([
    { nodeId: -1, why: 'below the range' },
    { nodeId: 1024, why: 'above the range' },
    { nodeId: 1.5, why: 'not an integer' },
    { nodeId: Number.NaN, why: 'not a number' },
  ])('refuses to be constructed with a node id $why', ({ nodeId }) => {
    expect(() => new SnowflakeGenerator({ nodeId })).toThrow(SnowflakeConfigurationError);
    expect(() => new SnowflakeGenerator({ nodeId })).toThrow(/0 and 1023/);
  });

  // Two replicas of the same service, minting at the same instant. This is the
  // property the whole node id exists for, and the mask added for the burst
  // above is what keeps it true past 4,096.
  it('never lets two node ids produce the same identifier', () => {
    const burst = 5_000;
    const seven = new SnowflakeGenerator({ nodeId: 7, clock: clockTickingEvery(burst) });
    const eight = new SnowflakeGenerator({ nodeId: 8, clock: clockTickingEvery(burst) });

    const fromSeven = new Set(Array.from({ length: burst }, () => seven.next()));
    const fromEight = Array.from({ length: burst }, () => eight.next());

    expect(fromEight.filter((id) => fromSeven.has(id))).toEqual([]);
  });

  // The id below is arithmetic anyone can check by hand: 20,000,000,000 ms
  // after the project epoch (231 days in), node 7, sequence 1, laid out as
  // timestamp << 22 | nodeId << 12 | sequence.
  //
  //   20_000_000_000 * 4_194_304  +  7 * 4_096  +  1  =  83886080000028673
  //
  // Parsed as a JSON number it comes back 83886080000028670 — three digits
  // wrong, no error raised anywhere. That is the whole reason ids leave this
  // library as strings.
  it('serialises as a JSON string, which a JSON number would corrupt', () => {
    // A clock held still, so both ids land in the same millisecond and the
    // second one carries sequence 1.
    const clock = () => SNOWFLAKE_EPOCH_MS + 20_000_000_000;
    const generator = new SnowflakeGenerator({ nodeId: 7, clock });
    generator.next();
    const id = generator.next();

    expect(id).toBe('83886080000028673');
    expect(JSON.stringify({ id })).toBe('{"id":"83886080000028673"}');

    expect(BigInt(id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(String(Number(id))).toBe('83886080000028670');
  });

  // A host whose clock predates the project epoch would encode a negative
  // timestamp: ids below zero, ordering inverted, and a BIGINT column that
  // accepts them without complaint. Caught at construction, where a misconfigured
  // host is still cheap.
  it('refuses to be constructed on a host whose clock predates the epoch', () => {
    const clock = () => SNOWFLAKE_EPOCH_MS - 1;

    expect(() => new SnowflakeGenerator({ nodeId: 7, clock })).toThrow(SnowflakeConfigurationError);
    expect(() => new SnowflakeGenerator({ nodeId: 7, clock })).toThrow(/before .*2026-01-01/);
  });
});
