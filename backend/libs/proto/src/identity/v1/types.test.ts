import { loadSync } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import { identityProtoPath } from '../../paths';
import type {
  GetProfileRequest,
  LoginRequest,
  LoginResponse,
  Profile,
  RegisterRequest,
  RegisterResponse,
  UpdateProfileRequest,
} from './types';

/**
 * types.ts is hand-written to mirror identity.proto, and nothing makes that
 * true. A field added to the .proto and forgotten here used to surface as a
 * runtime `undefined` at the call site — the kind of bug that reaches a
 * container before it reaches a compiler.
 *
 * These tests are that missing link. Each object below is `satisfies
 * Record<keyof T, true>`, which fails to compile if a TypeScript field is
 * missing from it, and is then compared against the field names the
 * .proto actually declares. Drift in either direction is a failing test.
 */
const REGISTER_REQUEST = {
  handle: true,
  password: true,
} satisfies Record<keyof RegisterRequest, true>;

const REGISTER_RESPONSE = {
  id: true,
  handle: true,
  displayName: true,
  createdAt: true,
} satisfies Record<keyof RegisterResponse, true>;

const LOGIN_REQUEST = {
  handle: true,
  password: true,
  userAgent: true,
} satisfies Record<keyof LoginRequest, true>;

const LOGIN_RESPONSE = {
  accessToken: true,
  refreshToken: true,
  accessTokenExpiresAt: true,
  refreshTokenExpiresAt: true,
  userId: true,
} satisfies Record<keyof LoginResponse, true>;

const GET_PROFILE_REQUEST = {
  handle: true,
} satisfies Record<keyof GetProfileRequest, true>;

/**
 * `Record<keyof T, true>` uses `keyof`, which includes optional keys — so
 * `displayName` and `bio` still have to be listed, and the drift check still
 * fails if either is dropped from the .proto. Optionality is checked
 * separately, and over the wire, in field-presence.test.ts.
 */
const UPDATE_PROFILE_REQUEST = {
  userId: true,
  displayName: true,
  bio: true,
} satisfies Record<keyof UpdateProfileRequest, true>;

const PROFILE = {
  id: true,
  handle: true,
  displayName: true,
  bio: true,
  createdAt: true,
} satisfies Record<keyof Profile, true>;

const definition = loadSync(identityProtoPath(), { keepCase: false, longs: String });

/**
 * `keepCase: false` applies to this descriptor too, not only to the runtime
 * message objects: `display_name` in the .proto is already `displayName`
 * here. That is the same setting both the Gateway and Identity load with,
 * which is what makes the camelCase interfaces in types.ts correct in the
 * first place — load with `keepCase: true` and every one of them is wrong.
 */
function protoField(messageName: string, fieldName: string) {
  const message = definition[`identity.v1.${messageName}`];
  expect(message, `identity.v1.${messageName} is missing from the .proto`).toBeDefined();

  const fields = (message as { type: { field: { name: string; type: string }[] } }).type.field;

  return fields.find((field) => field.name === fieldName);
}

function protoFields(messageName: string): string[] {
  const message = definition[`identity.v1.${messageName}`];
  expect(message, `identity.v1.${messageName} is missing from the .proto`).toBeDefined();

  return (message as { type: { field: { name: string }[] } }).type.field.map((field) => field.name);
}

describe('identity.proto and its hand-written types', () => {
  it('declares every RPC on IdentityService', () => {
    const service = definition['identity.v1.IdentityService'];

    expect(Object.keys(service ?? {}).sort()).toEqual([
      'GetProfile',
      'Login',
      'Register',
      'UpdateProfile',
    ]);
  });

  it.each([
    ['RegisterRequest', REGISTER_REQUEST],
    ['RegisterResponse', REGISTER_RESPONSE],
    ['LoginRequest', LOGIN_REQUEST],
    ['LoginResponse', LOGIN_RESPONSE],
    ['GetProfileRequest', GET_PROFILE_REQUEST],
    ['UpdateProfileRequest', UPDATE_PROFILE_REQUEST],
    ['Profile', PROFILE],
  ])('%s carries exactly the fields TypeScript declares', (messageName, declared) => {
    expect(protoFields(messageName).sort()).toEqual(Object.keys(declared).sort());
  });

  /**
   * Snowflakes cross this wire as strings — a 64-bit id does not survive
   * JavaScript's 2^53-1 as a number, silently. A `.proto` that declared
   * `int64 user_id` would arrive as a truncated number or a Long object
   * depending on loader settings, and neither is what the JSON contract
   * promises.
   */
  it.each([
    ['RegisterResponse', 'id'],
    ['LoginResponse', 'userId'],
    ['Profile', 'id'],
    ['UpdateProfileRequest', 'userId'],
  ])('declares %s.%s as a proto string, never an integer', (messageName, fieldName) => {
    expect(protoField(messageName, fieldName)?.type).toBe('TYPE_STRING');
  });
});

/**
 * The .proto's own guard for the presence rule. field-presence.test.ts
 * proves the *behaviour* over the wire; this proves the declaration that
 * produces it, and fails the moment someone "tidies up" the keyword.
 *
 * Asserted on `oneofDecl` and not on the field's own `proto3Optional` flag,
 * which looks like the obvious place and is not: @grpc/proto-loader builds
 * its descriptor through protobufjs, which reports `proto3Optional: false`
 * for every field including the optional ones. A test written against that
 * flag passes for the wrong reason on a `.proto` with no `optional` at all.
 *
 * What `optional` really compiles to is a synthetic one-field oneof, named
 * with a leading underscore, and that does survive into the descriptor.
 */
describe('the PATCH fields keep their field presence', () => {
  function syntheticOneofs(messageName: string): string[] {
    const message = definition[`identity.v1.${messageName}`];
    expect(message, `identity.v1.${messageName} is missing from the .proto`).toBeDefined();

    return (message as { type: { oneofDecl: { name: string }[] } }).type.oneofDecl.map(
      (oneof) => oneof.name,
    );
  }

  it('declares both PATCH fields optional, so unset stays distinguishable from ""', () => {
    expect(syntheticOneofs('UpdateProfileRequest').sort()).toEqual(['_bio', '_displayName']);
  });

  it('leaves Profile a plain message: a read has nothing to leave alone', () => {
    expect(syntheticOneofs('Profile')).toEqual([]);
  });

  it('leaves the pre-existing messages untouched', () => {
    // Field presence is not free — it costs a oneof per field in the
    // descriptor. It belongs on the PATCH and nowhere it is not needed.
    expect(syntheticOneofs('LoginRequest')).toEqual([]);
    expect(syntheticOneofs('RegisterRequest')).toEqual([]);
  });
});
