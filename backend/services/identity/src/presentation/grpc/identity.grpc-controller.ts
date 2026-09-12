import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import type {
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
} from '@x-clone/proto';
import { withFieldViolation } from '@x-clone/proto';
import { LoginUseCase } from '../../application/login.use-case';
import { RegisterUserUseCase } from '../../application/register-user.use-case';
import {
  DomainValidationError,
  HandleTakenError,
  InvalidCredentialsError,
} from '../../domain/errors';

/**
 * Only the methods this controller calls — see the test for why not the
 * concrete classes. The DI tokens are still the classes themselves (below):
 * an interface has no runtime representation for Nest's reflection to find.
 */
type RegisterUser = Pick<RegisterUserUseCase, 'execute'>;
type Login = Pick<LoginUseCase, 'execute'>;

@Controller()
export class IdentityGrpcController {
  constructor(
    @Inject(RegisterUserUseCase) private readonly registerUser: RegisterUser,
    @Inject(LoginUseCase) private readonly loginUser: Login,
  ) {}

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
      throw toRpcException(error, 'Register');
    }
  }

  @GrpcMethod('IdentityService', 'Login')
  async login(data: LoginRequest): Promise<LoginResponse> {
    try {
      const result = await this.loginUser.execute({
        handle: data.handle,
        password: data.password,
        // proto3 has no null: an absent User-Agent arrives as ''. Turning
        // it back into undefined here is what lets the session row store a
        // real NULL rather than an empty string pretending to be one.
        ...(data.userAgent !== '' && { userAgent: data.userAgent }),
      });

      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
        refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
        userId: result.userId,
      };
    } catch (error) {
      throw toRpcException(error, 'Login');
    }
  }
}

/**
 * Every *validation* failure this service raises names one field — see
 * docs/04-api-contracts.md. The field rides in gRPC metadata (rather than
 * google.rpc.BadRequest) because @x-clone/proto's FieldViolation already
 * covers the one-field-per-error case this system needs; the Gateway reads
 * it back to build the RFC 9457 response.
 *
 * The exception is InvalidCredentialsError below, which names none on
 * purpose. It is the only branch here that carries no metadata at all.
 */
function toRpcException(error: unknown, rpc: string): RpcException {
  if (error instanceof DomainValidationError) {
    return new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: error.reason,
      metadata: withFieldViolation(new Metadata(), { field: error.field, reason: error.reason }),
    });
  }

  /**
   * UNAUTHENTICATED, and — unlike every other branch here — no field
   * violation and no reason. The message is the same constant string for
   * an unknown handle as for a wrong password, because naming which one
   * failed is exactly the account-enumeration answer the domain error
   * exists to withhold. A `field: 'handle'` here would undo all of it.
   */
  if (error instanceof InvalidCredentialsError) {
    return new RpcException({
      code: GrpcStatus.UNAUTHENTICATED,
      message: error.message,
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
  // The RPC name is passed in rather than hard-coded: this function serves
  // every method on the controller, and a log line that always said
  // "Register" would point at the wrong one half the time.
  console.error(`identity: unexpected error in ${rpc}`, error);

  return new RpcException({
    code: GrpcStatus.INTERNAL,
    message: 'internal error',
  });
}
