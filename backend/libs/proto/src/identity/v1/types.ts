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

export interface IdentityServiceClient {
  register(request: RegisterRequest): Promise<RegisterResponse>;
}

export const IDENTITY_PACKAGE_NAME = 'identity.v1';
export const IDENTITY_SERVICE_NAME = 'IdentityService';
