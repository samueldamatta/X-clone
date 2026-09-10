import {
  loadPackageDefinition,
  Metadata,
  Server,
  ServerCredentials,
  status as GrpcStatus,
  type ServiceClientConstructor,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { ProblemDetailsException } from '@x-clone/problem-details';
import {
  identityProtoPath,
  withFieldViolation,
  type RegisterRequest,
  type RegisterResponse,
} from '@x-clone/proto';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityGrpcClient } from './identity.grpc-client';

type RegisterHandler = (
  call: ServerUnaryCall<RegisterRequest, RegisterResponse>,
  callback: sendUnaryData<RegisterResponse>,
) => void;

let running: { client: IdentityGrpcClient; stop: () => Promise<void> } | undefined;

/** Binds to port 0 — the OS picks a free one, so tests never collide. */
async function startIdentity(handler: RegisterHandler): Promise<IdentityGrpcClient> {
  const definition = loadSync(identityProtoPath(), { keepCase: false, defaults: true });
  const proto = loadPackageDefinition(definition) as unknown as {
    identity: { v1: { IdentityService: ServiceClientConstructor } };
  };

  const server = new Server();
  server.addService(proto.identity.v1.IdentityService.service, { Register: handler });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(bound);
    });
  });

  const client = new IdentityGrpcClient(`127.0.0.1:${port.toString()}`);
  running = {
    client,
    stop: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
  return client;
}

afterEach(async () => {
  if (running !== undefined) {
    running.client.onApplicationShutdown();
    await running.stop();
    running = undefined;
  }
});

describe('IdentityGrpcClient over a real channel', () => {
  it('sends the request and reads the response back in camelCase', async () => {
    const client = await startIdentity((call, callback) => {
      callback(null, {
        id: '1847362819999',
        handle: call.request.handle,
        // The wire field is `display_name`. If the loader options ever stop
        // converting, this assertion is what notices.
        displayName: call.request.handle,
        createdAt: '2026-08-20T12:00:00.000Z',
      });
    });

    await expect(client.register({ handle: 'sam', password: 'correcthorse1' })).resolves.toEqual({
      id: '1847362819999',
      handle: 'sam',
      displayName: 'sam',
      createdAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('rejects with a problem-details exception, field violation intact', async () => {
    const client = await startIdentity((_call, callback) => {
      callback({
        code: GrpcStatus.ALREADY_EXISTS,
        details: 'handle "sam" is already taken',
        metadata: withFieldViolation(new Metadata(), {
          field: 'handle',
          reason: 'handle "sam" is already taken',
        }),
      });
    });

    const failure = client.register({ handle: 'sam', password: 'correcthorse1' });

    await expect(failure).rejects.toBeInstanceOf(ProblemDetailsException);
    await expect(failure).rejects.toMatchObject({ field: 'handle' });
  });
});
