import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import type { RegisterRequest, RegisterResponse } from '@x-clone/proto';
import { withFieldViolation } from '@x-clone/proto';
import { RegisterUserUseCase } from '../../application/register-user.use-case';
import { DomainValidationError, HandleTakenError } from '../../domain/errors';

/**
 * Only the method this controller calls — see the test for why not the
 * concrete class. The DI token is still the class itself (below): an
 * interface has no runtime representation for Nest's reflection to find.
 */
type RegisterUser = Pick<RegisterUserUseCase, 'execute'>;

@Controller()
export class IdentityGrpcController {
  constructor(@Inject(RegisterUserUseCase) private readonly registerUser: RegisterUser) {}

  @GrpcMethod('IdentityService', 'Register')
  async register(data: RegisterRequest): Promise<RegisterResponse> {
    try {
      const user = await this.registerUser.execute({
        handle: data.handle,
        password: data.password,
      });
      return {
        id: user.id,
        handle: user.handle,
        displayName: user.displayName,
        createdAt: user.createdAt.toISOString(),
      };
    } catch (error) {
      throw toRpcException(error);
    }
  }
}

/**
 * Every failure this service raises names one field — see
 * docs/04-api-contracts.md. The field rides in gRPC metadata (rather than
 * google.rpc.BadRequest) because @x-clone/proto's FieldViolation already
 * covers the one-field-per-error case this system needs; the Gateway reads
 * it back to build the RFC 9457 response.
 */
function toRpcException(error: unknown): RpcException {
  if (error instanceof DomainValidationError) {
    return new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: error.reason,
      metadata: withFieldViolation(new Metadata(), { field: error.field, reason: error.reason }),
    });
  }

  if (error instanceof HandleTakenError) {
    return new RpcException({
      code: GrpcStatus.ALREADY_EXISTS,
      message: error.message,
      metadata: withFieldViolation(new Metadata(), { field: error.field, reason: error.message }),
    });
  }

  if (error instanceof RpcException) {
    return error;
  }

  // Logged here, server-side, precisely because the client never sees more
  // than "internal error" — this is the one place that detail is not lost.
  console.error('identity: unexpected error in Register', error);

  return new RpcException({
    code: GrpcStatus.INTERNAL,
    message: 'internal error',
  });
}
