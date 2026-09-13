import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import type {
  GetProfileRequest,
  LoginRequest,
  LoginResponse,
  Profile as ProfileMessage,
  RegisterRequest,
  RegisterResponse,
  UpdateProfileRequest,
} from '@x-clone/proto';
import { withFieldViolation } from '@x-clone/proto';
import { GetProfileUseCase } from '../../application/get-profile.use-case';
import { LoginUseCase } from '../../application/login.use-case';
import { RegisterUserUseCase } from '../../application/register-user.use-case';
import { UpdateProfileUseCase } from '../../application/update-profile.use-case';
import {
  DomainValidationError,
  EmptyProfileUpdateError,
  HandleTakenError,
  InvalidCredentialsError,
  ProfileNotFoundError,
} from '../../domain/errors';
import type { Profile } from '../../domain/profile';

/**
 * Only the methods this controller calls — see the test for why not the
 * concrete classes. The DI tokens are still the classes themselves (below):
 * an interface has no runtime representation for Nest's reflection to find.
 */
type RegisterUser = Pick<RegisterUserUseCase, 'execute'>;
type Login = Pick<LoginUseCase, 'execute'>;
type GetProfile = Pick<GetProfileUseCase, 'execute'>;
type UpdateProfile = Pick<UpdateProfileUseCase, 'execute'>;

@Controller()
export class IdentityGrpcController {
  constructor(
    @Inject(RegisterUserUseCase) private readonly registerUser: RegisterUser,
    @Inject(LoginUseCase) private readonly loginUser: Login,
    @Inject(GetProfileUseCase) private readonly getProfileUseCase: GetProfile,
    @Inject(UpdateProfileUseCase) private readonly updateProfileUseCase: UpdateProfile,
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

  @GrpcMethod('IdentityService', 'GetProfile')
  async getProfile(data: GetProfileRequest): Promise<ProfileMessage> {
    try {
      return toProfileMessage(await this.getProfileUseCase.execute(data.handle));
    } catch (error) {
      throw toRpcException(error, 'GetProfile');
    }
  }

  @GrpcMethod('IdentityService', 'UpdateProfile')
  async updateProfile(data: UpdateProfileRequest): Promise<ProfileMessage> {
    try {
      /**
       * Spread only what the client sent. `optional` in the .proto means an
       * unset field is absent from `data` entirely, and this rebuild has to
       * preserve that: writing `displayName: data.displayName` would put the
       * key on the object with the value undefined, and `'displayName' in
       * input` — which is what the use case's `!== undefined` amounts to —
       * would then read an omission as a request to change something.
       *
       * '' survives this, and must: it is how a bio is cleared.
       */
      const profile = await this.updateProfileUseCase.execute({
        userId: data.userId,
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.bio !== undefined && { bio: data.bio }),
      });

      return toProfileMessage(profile);
    } catch (error) {
      throw toRpcException(error, 'UpdateProfile');
    }
  }
}

/**
 * The domain's Date becomes RFC 3339 here and nowhere else, the same way
 * Register and Login do it. protobuf has a Timestamp type; this system uses
 * strings because the public API's JSON does, and one conversion is cheaper
 * to keep honest than two.
 */
function toProfileMessage(profile: Profile): ProfileMessage {
  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    bio: profile.bio,
    createdAt: profile.createdAt.toISOString(),
  };
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

  /**
   * NOT_FOUND, which the Gateway maps to 404. Safe to be specific about,
   * unlike the login rejection above: a public profile read exists to
   * answer "does this handle exist?", so there is nothing here for a
   * generic message to protect.
   */
  if (error instanceof ProfileNotFoundError) {
    return new RpcException({
      code: GrpcStatus.NOT_FOUND,
      message: error.message,
    });
  }

  /**
   * INVALID_ARGUMENT with no field violation — the second and last place in
   * this service that carries none. The fault is the body as a whole, so
   * there is no single field to name; see the error's own comment.
   */
  if (error instanceof EmptyProfileUpdateError) {
    return new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
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
