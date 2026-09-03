import type { Metadata } from '@grpc/grpc-js';

/**
 * Every RPC in this system that validates input rejects with exactly one
 * offending field — see docs/04-api-contracts.md's problem-details
 * convention. A gRPC status carries a code and a message but no structured
 * payload, so the field name rides in metadata instead of being parsed out
 * of a message string on the other side.
 *
 * This is a deliberate simplification over google.rpc.BadRequest
 * (the "proper" protobuf way to carry field violations): one field per
 * error is all this system's validation ever reports, so a JSON blob in one
 * metadata key does the job without pulling in google/rpc/error_details.proto.
 */
export const FIELD_VIOLATION_METADATA_KEY = 'x-field-violation';

export interface FieldViolation {
  field: string;
  reason: string;
}

export function withFieldViolation(metadata: Metadata, violation: FieldViolation): Metadata {
  metadata.set(FIELD_VIOLATION_METADATA_KEY, JSON.stringify(violation));
  return metadata;
}

export function readFieldViolation(metadata: Metadata): FieldViolation | undefined {
  const raw = metadata.get(FIELD_VIOLATION_METADATA_KEY)[0];
  if (typeof raw !== 'string') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'field' in parsed &&
      'reason' in parsed &&
      typeof (parsed as { field: unknown }).field === 'string' &&
      typeof (parsed as { reason: unknown }).reason === 'string'
    ) {
      return parsed as FieldViolation;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
