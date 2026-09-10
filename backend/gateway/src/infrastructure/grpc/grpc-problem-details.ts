import { type Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException, reasonPhrase } from '@x-clone/problem-details';
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
const HTTP_STATUS: Partial<Record<GrpcStatus, number>> = {
  [GrpcStatus.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [GrpcStatus.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [GrpcStatus.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [GrpcStatus.UNAUTHENTICATED]: HttpStatus.UNAUTHORIZED,
  [GrpcStatus.RESOURCE_EXHAUSTED]: HttpStatus.TOO_MANY_REQUESTS,
  // 504, not 500: the request may well have succeeded upstream. The Gateway
  // simply stopped waiting for the answer, and the client needs to know that
  // retrying is not obviously safe.
  [GrpcStatus.DEADLINE_EXCEEDED]: HttpStatus.GATEWAY_TIMEOUT,
  [GrpcStatus.UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
};

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
  const status = isGrpcFailure(error)
    ? (HTTP_STATUS[error.code] ?? FIRST_SERVER_ERROR_STATUS)
    : FIRST_SERVER_ERROR_STATUS;

  // Titles come from the shared table, so a 409 from this Gateway reads the
  // same whether it originated in gRPC metadata or in a Nest pipe.
  const title = reasonPhrase(status);

  if (!isGrpcFailure(error) || status >= FIRST_SERVER_ERROR_STATUS) {
    return new ProblemDetailsException({ status, title });
  }

  const violation = error.metadata === undefined ? undefined : readFieldViolation(error.metadata);

  return new ProblemDetailsException({
    status,
    title,
    detail: error.details,
    ...(violation !== undefined && { field: violation.field }),
  });
}
