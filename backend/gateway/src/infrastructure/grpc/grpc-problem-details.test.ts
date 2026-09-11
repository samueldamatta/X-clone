import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { withFieldViolation } from '@x-clone/proto';
import { describe, expect, it } from 'vitest';
import { toProblemDetails } from './grpc-problem-details';

function grpcError(code: GrpcStatus, details: string, metadata?: Metadata) {
  return Object.assign(new Error(`${code.toString()} ${details}`), { code, details, metadata });
}

describe('toProblemDetails', () => {
  it('carries a validation failure through as 400, naming the offending field', () => {
    const metadata = withFieldViolation(new Metadata(), {
      field: 'password',
      reason: 'must be at least 8 characters',
    });

    const problem = toProblemDetails(
      grpcError(GrpcStatus.INVALID_ARGUMENT, 'must be at least 8 characters', metadata),
    );

    expect(problem.toBody()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'must be at least 8 characters',
      field: 'password',
    });
  });

  it('maps a taken handle to 409, not 400', () => {
    const metadata = withFieldViolation(new Metadata(), {
      field: 'handle',
      reason: 'handle "sam" is already taken',
    });

    const problem = toProblemDetails(
      grpcError(GrpcStatus.ALREADY_EXISTS, 'handle "sam" is already taken', metadata),
    );

    expect(problem.getStatus()).toBe(409);
    expect(problem.toBody().field).toBe('handle');
  });

  it('still answers a 4xx that arrives without metadata', () => {
    const problem = toProblemDetails(grpcError(GrpcStatus.NOT_FOUND, 'no such user'));

    expect(problem.toBody()).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'no such user',
    });
  });

  it('does not forward the upstream message on a 5xx', () => {
    // "connect ECONNREFUSED 10.0.1.7:8081" tells the caller our topology
    // and tells them nothing they can act on.
    const problem = toProblemDetails(
      grpcError(GrpcStatus.UNAVAILABLE, 'connect ECONNREFUSED 10.0.1.7:8081'),
    );

    expect(problem.toBody()).toEqual({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
    });
  });

  it('reports an expired deadline as 504, since the write may have landed upstream', () => {
    expect(
      toProblemDetails(grpcError(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded')).getStatus(),
    ).toBe(504);
  });

  it('falls back to 500 for a code with no mapping, and for a non-gRPC error', () => {
    expect(toProblemDetails(grpcError(GrpcStatus.DATA_LOSS, 'boom')).getStatus()).toBe(500);
    expect(toProblemDetails(new Error('plain')).getStatus()).toBe(500);
    expect(toProblemDetails(undefined).getStatus()).toBe(500);
  });
});
