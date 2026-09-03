import { describe, expect, it } from 'vitest';

import { SnowflakeConfigurationError } from './errors';
import { nodeIdFromEnv } from './node-id';

describe('nodeIdFromEnv', () => {
  it('reads a valid node id', () => {
    expect(nodeIdFromEnv({ SNOWFLAKE_NODE_ID: '42' })).toBe(42);
  });

  it('accepts the whole ten-bit range', () => {
    expect(nodeIdFromEnv({ SNOWFLAKE_NODE_ID: '0' })).toBe(0);
    expect(nodeIdFromEnv({ SNOWFLAKE_NODE_ID: '1023' })).toBe(1023);
  });

  // Each message has to name the variable and what is wrong with it. A service
  // that dies at boot printing "invalid configuration" costs whoever is on call
  // the twenty minutes this test exists to save.
  it.each([
    { value: undefined, expected: /SNOWFLAKE_NODE_ID is not set/ },
    { value: '', expected: /SNOWFLAKE_NODE_ID is not set/ },
    { value: 'one', expected: /SNOWFLAKE_NODE_ID must be an integer.*got "one"/ },
    { value: '3.5', expected: /SNOWFLAKE_NODE_ID must be an integer.*got "3.5"/ },
    { value: '1024', expected: /between 0 and 1023, got 1024/ },
    { value: '-1', expected: /between 0 and 1023, got -1/ },
  ])('refuses $value with a message naming the problem', ({ value, expected }) => {
    const env = value === undefined ? {} : { SNOWFLAKE_NODE_ID: value };

    expect(() => nodeIdFromEnv(env)).toThrow(SnowflakeConfigurationError);
    expect(() => nodeIdFromEnv(env)).toThrow(expected);
  });
});
