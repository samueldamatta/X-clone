import { describe, expect, it } from 'vitest';
import { ProblemDetailsException } from './problem-details.exception';

describe('ProblemDetailsException', () => {
  it('defaults type to about:blank and omits absent optional members', () => {
    const exception = new ProblemDetailsException({ status: 409, title: 'Handle taken' });

    expect(exception.toBody()).toEqual({
      type: 'about:blank',
      title: 'Handle taken',
      status: 409,
    });
  });

  it('includes detail, instance and field when given', () => {
    const exception = new ProblemDetailsException({
      status: 422,
      title: 'Weak password',
      detail: 'must be at least 8 characters',
      instance: '/v1/auth/register',
      field: 'password',
    });

    expect(exception.toBody()).toEqual({
      type: 'about:blank',
      title: 'Weak password',
      status: 422,
      detail: 'must be at least 8 characters',
      instance: '/v1/auth/register',
      field: 'password',
    });
  });
});
