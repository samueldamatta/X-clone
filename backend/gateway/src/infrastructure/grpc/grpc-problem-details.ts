import { type Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException } from '@x-clone/problem-details';
import { readFieldViolation } from '@x-clone/proto';

/**
 * gRPC status codes into HTTP ones. Not in a service-specific file: the
 * mapping is a property of the two protocols, not of Identity, and the
 * Tweet and Graph clients will want exactly this.
 *
 * The codes absent from this table are deliberate. UNIMPLEMENTED, INTERNAL,
 * DATA_LOSS and friends all mean "we are broken", and they land on 500
 * through the fallback below.
 */
const HTTP_FAILURES: Partial<Record<GrpcStatus, { status: number; title: string }>> = {
  [GrpcStatus.INVALID_ARGUMENT]: { status: HttpStatus.BAD_REQUEST, title: 'Bad Request' },
  [GrpcStatus.NOT_FOUND]: { status: HttpStatus.NOT_FOUND, title: 'Not Found' },
  [GrpcStatus.ALREADY_EXISTS]: { status: HttpStatus.CONFLICT, title: 'Conflict' },
  [GrpcStatus.PERMISSION_DENIED]: { status: HttpStatus.FORBIDDEN, title: 'Forbidden' },
  [GrpcStatus.UNAUTHENTICATED]: { status: HttpStatus.UNAUTHORIZED, title: 'Unauthorized' },
  [GrpcStatus.RESOURCE_EXHAUSTED]: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too Many Requests',
  },
  // 504, not 500: the request may well have succeeded upstream. The Gateway
  // simply stopped waiting for the answer, and the client needs to know that
  // retrying is not obviously safe.
  [GrpcStatus.DEADLINE_EXCEEDED]: { status: HttpStatus.GATEWAY_TIMEOUT, title: 'Gateway Timeout' },
  [GrpcStatus.UNAVAILABLE]: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
  },
};

const INTERNAL = { status: HttpStatus.INTERNAL_SERVER_ERROR, title: 'Internal Server Error' };

/**
 * The line between "you got it wrong" and "we got it wrong", which is also
 * the line where forwarding the upstream message stops being helpful and
 * starts being a leak. Exported because the client applies the same rule
 * when deciding what to log.
 */
export const FIRST_SERVER_ERROR_STATUS = 500;

/**
 * grpc-js declares ServiceError as an interface, so `instanceof` is not
 * available — what arrives is a plain Error decorated with these fields.
 */
interface GrpcFailure {
  code: GrpcStatus;
  details: string;
  metadata?: Metadata;
}

function isGrpcFailure(error: unknown): error is GrpcFailure {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number' &&
    'details' in error &&
    typeof error.details === 'string'
  );
}

/**
 * Turns an upstream gRPC failure into the RFC 9457 response the public API
 * promises (docs/04-api-contracts.md).
 *
 * The rule that matters is the 5xx one: a 4xx message was written for the
 * caller by the service that rejected them ("must be at least 8
 * characters"), and passing it through is the whole point. A 5xx message
 * was written for us — connection strings, hostnames, stack context — and
 * forwarding it hands an attacker a free map of the internal network.
 */
export function toProblemDetails(error: unknown): ProblemDetailsException {
  if (!isGrpcFailure(error)) {
    return new ProblemDetailsException(INTERNAL);
  }

  const failure = HTTP_FAILURES[error.code] ?? INTERNAL;

  if (failure.status >= FIRST_SERVER_ERROR_STATUS) {
    return new ProblemDetailsException(failure);
  }

  const violation = error.metadata === undefined ? undefined : readFieldViolation(error.metadata);

  return new ProblemDetailsException({
    ...failure,
    detail: error.details,
    ...(violation !== undefined && { field: violation.field }),
  });
}
