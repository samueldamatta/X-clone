import {
  credentials,
  loadPackageDefinition,
  type ChannelCredentials,
  Server,
  ServerCredentials,
  type ServiceDefinition,
  type UntypedServiceImplementation,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityProtoPath } from '../../paths';

/**
 * The one library guarantee the profile PATCH is built on, pinned by a real
 * client-to-server round trip rather than by reading the documentation.
 *
 * The rule: `optional string bio` must arrive *absent* when the client did
 * not set it, and present-and-empty when the client set it to ''. Absent
 * means "leave my bio alone"; '' means "clear my bio". Collapse the two and
 * every client that renames itself silently erases its own bio.
 *
 * proto3 does not give a plain `string` that distinction — an unset string
 * and "" are byte-identical on the wire. `optional` reinstates it, via a
 * synthetic oneof. What is genuinely unobvious, and what this file exists to
 * check, is that `defaults: true` does not then paper over it: that setting
 * fills unset scalars with their zero value, which is precisely what would
 * turn an absent bio back into ''. It does not apply to fields with
 * presence, and both sides of this system load with `defaults: true`.
 *
 * A unit test against a mock client could not catch this. The behaviour
 * lives in the encode/decode path, so the test has to cross it.
 */
const LOADER_OPTIONS = {
  // Exactly the options the Gateway and Identity load with. A divergence
  // here would make this test prove something about a configuration nobody
  // runs.
  keepCase: false,
  longs: String,
  defaults: true,
  oneofs: true,
} as const;

interface ProfileReply {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  createdAt: string;
}

type UpdateProfileCall = { request: Record<string, unknown> };
type UpdateProfileClient = {
  updateProfile(
    request: Record<string, unknown>,
    callback: (error: Error | null, reply?: ProfileReply) => void,
  ): void;
  close(): void;
};

const definition = loadSync(identityProtoPath(), LOADER_OPTIONS);
const proto = loadPackageDefinition(definition) as unknown as {
  identity: {
    v1: {
      IdentityService: {
        service: ServiceDefinition;
        new (url: string, channelCredentials: ChannelCredentials): unknown;
      };
    };
  };
};

let server: Server;
let client: UpdateProfileClient;

/** What the server handler saw, captured from the last call. */
let received: Record<string, unknown>;

beforeAll(async () => {
  server = new Server();

  const implementation: UntypedServiceImplementation = {
    UpdateProfile: (
      call: unknown,
      callback: (error: Error | null, reply: ProfileReply) => void,
    ) => {
      received = (call as UpdateProfileCall).request;
      callback(null, {
        id: '1',
        handle: 'sam',
        displayName: 'Sam',
        bio: '',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    },
  };

  server.addService(proto.identity.v1.IdentityService.service, implementation);

  // Port 0: the OS picks a free one and reports it back. A hard-coded port
  // is a test that fails on a machine where something else already holds it.
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(bound);
    });
  });

  client = new proto.identity.v1.IdentityService(
    `127.0.0.1:${port.toString()}`,
    credentials.createInsecure(),
  ) as UpdateProfileClient;
});

afterAll(() => {
  client.close();
  server.forceShutdown();
});

function updateProfile(request: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    client.updateProfile(request, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('UpdateProfileRequest field presence over a real gRPC round trip', () => {
  it('omits a field the client did not set, despite defaults: true', async () => {
    await updateProfile({ userId: '1' });

    expect(received).toEqual({ userId: '1' });
    expect('bio' in received).toBe(false);
    expect('displayName' in received).toBe(false);
  });

  it('delivers an empty bio as present and empty, not as absent', async () => {
    await updateProfile({ userId: '1', bio: '' });

    expect('bio' in received).toBe(true);
    expect(received.bio).toBe('');
  });

  it('keeps the two apart in the same message', async () => {
    // The case that matters in practice: renaming without touching the bio.
    await updateProfile({ userId: '1', displayName: 'Sam' });

    expect(received.displayName).toBe('Sam');
    expect('bio' in received).toBe(false);
  });

  it('carries a bio with content unchanged', async () => {
    await updateProfile({ userId: '1', bio: 'building a twitter clone' });

    expect(received.bio).toBe('building a twitter clone');
  });
});
