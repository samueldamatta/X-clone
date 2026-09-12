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

/**
 * No account answers to this handle.
 *
 * Unlike InvalidCredentialsError above, this one is safe to be specific
 * about: a profile read is public, so "does this handle exist?" is a
 * question the endpoint exists to answer. Hiding it here would cost a real
 * feature — a client cannot tell "free handle" from "server broke" — and
 * buy nothing, because anyone can learn the same thing by visiting the
 * profile page.
 */
export class ProfileNotFoundError extends Error {
  private constructor(message: string) {
    super(message);
    this.name = 'ProfileNotFoundError';
  }

  /** The public read: somebody asked for a handle nobody holds. */
  static byHandle(handle: string): ProfileNotFoundError {
    return new ProfileNotFoundError(`no account with handle "${handle}"`);
  }

  /**
   * The authenticated update, and a case that should not happen: the id
   * came from a token this system signed. It is reachable exactly once —
   * when an account is deleted while one of its access tokens is still
   * inside its fifteen-minute life.
   */
  static byId(userId: string): ProfileNotFoundError {
    return new ProfileNotFoundError(`no account with id "${userId}"`);
  }
}

/**
 * A PATCH that asks for nothing.
 *
 * The alternative — accept it, change nothing, answer 200 with the current
 * profile — is defensible and idempotent, and it is what makes this a real
 * decision rather than an obvious one. It was rejected for one reason: a
 * client that sends `{"displayname": "Sam"}` (wrong case, a typo anyone
 * makes once) would get a 200 and a profile that did not change, and would
 * have to notice on its own. Refusing turns a silent no-op into a message.
 *
 * The cost is that it names no field, which the API's own convention says
 * validation errors always do (docs/04-api-contracts.md). There is no
 * single field to name: the fault is in the body as a whole. Login is the
 * other place that carries no `field`, for an unrelated reason, and both
 * are written down there.
 */
export class EmptyProfileUpdateError extends Error {
  constructor() {
    super('no supported field was given to update');
    this.name = 'EmptyProfileUpdateError';
  }
}
