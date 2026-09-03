export type { IdentityServiceClient, RegisterRequest, RegisterResponse } from './identity/v1/types';
export { IDENTITY_PACKAGE_NAME, IDENTITY_SERVICE_NAME } from './identity/v1/types';
export { identityProtoPath } from './paths';
export {
  FIELD_VIOLATION_METADATA_KEY,
  withFieldViolation,
  readFieldViolation,
} from './grpc-errors';
export type { FieldViolation } from './grpc-errors';
