/**
 * Every validation failure in this service names exactly one offending
 * field — the Gateway turns that straight into the RFC 9457 `field` member
 * (docs/04-api-contracts.md). One error shape for every rule keeps the
 * gRPC → problem-details mapping in the presentation layer a single case
 * instead of one per rule.
 */
export class DomainValidationError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'DomainValidationError';
  }
}

/** A handle that is syntactically valid but already belongs to another account. */
export class HandleTakenError extends Error {
  readonly field = 'handle';

  constructor(readonly handle: string) {
    super(`handle "${handle}" is already taken`);
    this.name = 'HandleTakenError';
  }
}
