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

/**
 * The one failure in this service that names no field, on purpose.
 *
 * An unknown handle and a wrong password raise *this same instance shape*,
 * with no detail distinguishing them. Naming the field would answer the
 * question an attacker is actually asking — "does this handle exist?" —
 * and turn the login endpoint into an account enumeration oracle.
 *
 * Costing the user a worse error message is the price. It is a real cost:
 * someone who genuinely mistyped their handle is told only that something
 * was wrong. Every login form on the internet pays it.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('invalid handle or password');
    this.name = 'InvalidCredentialsError';
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
