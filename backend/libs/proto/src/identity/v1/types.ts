/**
 * Hand-written to mirror identity.proto. Loaded dynamically with
 * @grpc/proto-loader rather than generated with ts-proto, so nothing keeps
 * these in sync automatically — a field renamed in the .proto and not here
 * fails at the call site, not at compile time. Acceptable while this package
 * holds a single RPC; revisit with codegen if the surface grows.
 */
export interface RegisterRequest {
  handle: string;
  password: string;
}

export interface RegisterResponse {
  id: string;
  handle: string;
  displayName: string;
  createdAt: string;
}

export interface LoginRequest {
  handle: string;
  password: string;
  /** '' when the client sent no User-Agent — proto3 has no null. */
  userAgent: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  userId: string;
}

export interface GetProfileRequest {
  handle: string;
}

/**
 * `displayName` and `bio` are optional in TypeScript for the same reason
 * they are `optional` in the .proto: absent means "do not touch this", and
 * '' means "set it to empty". Widening either to a plain `string` here
 * would make the two indistinguishable in the type system even though the
 * wire keeps them apart — see field-presence.test.ts.
 *
 * There is no field naming whose profile to change. `userId` is the subject,
 * and it comes from a verified token.
 */
export interface UpdateProfileRequest {
  userId: string;
  displayName?: string;
  bio?: string;
}

export interface Profile {
  id: string;
  handle: string;
  displayName: string;
  /** '' for an account that never set one — never absent. */
  bio: string;
  createdAt: string;
}

export interface IdentityServiceClient {
  register(request: RegisterRequest): Promise<RegisterResponse>;
  login(request: LoginRequest): Promise<LoginResponse>;
  getProfile(request: GetProfileRequest): Promise<Profile>;
  updateProfile(request: UpdateProfileRequest): Promise<Profile>;
}

export const IDENTITY_PACKAGE_NAME = 'identity.v1';
export const IDENTITY_SERVICE_NAME = 'IdentityService';
