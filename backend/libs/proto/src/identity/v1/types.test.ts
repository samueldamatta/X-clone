import { loadSync } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';
import { identityProtoPath } from '../../paths';
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse } from './types';

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
  it('declares both RPCs on IdentityService', () => {
    const service = definition['identity.v1.IdentityService'];

    expect(Object.keys(service ?? {}).sort()).toEqual(['Login', 'Register']);
  });

  it.each([
    ['RegisterRequest', REGISTER_REQUEST],
    ['RegisterResponse', REGISTER_RESPONSE],
    ['LoginRequest', LOGIN_REQUEST],
    ['LoginResponse', LOGIN_RESPONSE],
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
  ])('declares %s.%s as a proto string, never an integer', (messageName, fieldName) => {
    expect(protoField(messageName, fieldName)?.type).toBe('TYPE_STRING');
  });
});
