import { SnowflakeGenerator } from '@x-clone/snowflake';
import type { IdGenerator } from '../../domain/ports/id-generator';

/** Thin adapter — the domain layer sees `IdGenerator`, never `@x-clone/snowflake`. */
export class SnowflakeIdGenerator implements IdGenerator {
  readonly #generator: SnowflakeGenerator;

  constructor(nodeId: number) {
    this.#generator = new SnowflakeGenerator({ nodeId });
  }

  next(): string {
    return this.#generator.next();
  }
}
