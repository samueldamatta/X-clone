import { DomainValidationError } from './errors';

const MIN_LENGTH = 8;

export function assertValidPassword(password: string): void {
  if (password.length < MIN_LENGTH) {
    throw new DomainValidationError(
      'password',
      `must be at least ${MIN_LENGTH.toString()} characters`,
    );
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new DomainValidationError('password', 'must contain at least one letter and one digit');
  }
}
