/**
 * Every timestamp a use case writes comes from here, never from `new Date()`
 * inline. Token lifetimes are the whole subject of this ticket, and a test
 * that cannot move time can only assert that an expiry is "roughly now plus
 * fifteen minutes" — which passes just as happily when the unit is wrong.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
