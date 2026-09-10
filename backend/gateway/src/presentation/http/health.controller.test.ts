import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports liveness without reaching any dependency', () => {
    // Constructed with no arguments — that is the assertion. The day this
    // needs a dependency injected to answer, the check has stopped being a
    // liveness probe.
    expect(new HealthController().check()).toEqual({ status: 'ok' });
  });
});
