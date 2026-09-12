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
  type LoginRequest,
  type LoginResponse,
  type RegisterRequest,
  type RegisterResponse,
} from '@x-clone/proto';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityGrpcClient } from './identity.grpc-client';

type Handler<Request, Response> = (
  call: ServerUnaryCall<Request, Response>,
  callback: sendUnaryData<Response>,
) => void;

type RegisterHandler = Handler<RegisterRequest, RegisterResponse>;
type LoginHandler = Handler<LoginRequest, LoginResponse>;

const notImplemented: Handler<never, never> = (_call, callback) => {
  callback({ code: GrpcStatus.UNIMPLEMENTED, details: 'not wired in this test' });
};

let running: { client: IdentityGrpcClient; stop: () => Promise<void> } | undefined;

/** Binds to port 0 — the OS picks a free one, so tests never collide. */
async function startIdentity(handlers: {
  Register?: RegisterHandler;
  Login?: LoginHandler;
}): Promise<IdentityGrpcClient> {
  const definition = loadSync(identityProtoPath(), { keepCase: false, defaults: true });
  const proto = loadPackageDefinition(definition) as unknown as {
    identity: { v1: { IdentityService: ServiceClientConstructor } };
  };

  const server = new Server();
  // Both methods always registered: grpc-js refuses to start a service
  // whose definition declares an RPC the implementation omits, so an
  // unused one gets a stub rather than being left out.
  server.addService(proto.identity.v1.IdentityService.service, {
    Register: handlers.Register ?? (notImplemented as unknown as RegisterHandler),
    Login: handlers.Login ?? (notImplemented as unknown as LoginHandler),
  });

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
    const client = await startIdentity({
      Register: (call, callback) => {
        callback(null, {
          id: '1847362819999',
          handle: call.request.handle,
          // The wire field is `display_name`. If the loader options ever stop
          // converting, this assertion is what notices.
          displayName: call.request.handle,
          createdAt: '2026-08-20T12:00:00.000Z',
        });
      },
    });

    await expect(client.register({ handle: 'sam', password: 'correcthorse1' })).resolves.toEqual({
      id: '1847362819999',
      handle: 'sam',
      displayName: 'sam',
      createdAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('rejects with a problem-details exception, field violation intact', async () => {
    const client = await startIdentity({
      Register: (_call, callback) => {
        callback({
          code: GrpcStatus.ALREADY_EXISTS,
          details: 'handle "sam" is already taken',
          metadata: withFieldViolation(new Metadata(), {
            field: 'handle',
            reason: 'handle "sam" is already taken',
          }),
        });
      },
    });

    const failure = client.register({ handle: 'sam', password: 'correcthorse1' });

    await expect(failure).rejects.toBeInstanceOf(ProblemDetailsException);
    await expect(failure).rejects.toMatchObject({ field: 'handle' });
  });

  it('carries a login through and reads the token pair back', async () => {
    const client = await startIdentity({
      Login: (call, callback) => {
        callback(null, {
          accessToken: `signed-for-${call.request.handle}`,
          refreshToken: 'opaque-token',
          accessTokenExpiresAt: '2026-08-20T12:15:00.000Z',
          refreshTokenExpiresAt: '2026-09-19T12:00:00.000Z',
          userId: '1847100000001',
        });
      },
    });

    await expect(
      client.login({ handle: 'sam', password: 'correcthorse1', userAgent: 'curl/8.4.0' }),
    ).resolves.toEqual({
      accessToken: 'signed-for-sam',
      refreshToken: 'opaque-token',
      // snake_case in the .proto, camelCase here — the loader setting that
      // makes this true is the same one RegisterResponse relies on.
      accessTokenExpiresAt: '2026-08-20T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-19T12:00:00.000Z',
      userId: '1847100000001',
    });
  });

  it('forwards the user agent across the wire', async () => {
    let seen: string | undefined;
    const client = await startIdentity({
      Login: (call, callback) => {
        seen = call.request.userAgent;
        callback(null, {
          accessToken: 'a',
          refreshToken: 'r',
          accessTokenExpiresAt: '2026-08-20T12:15:00.000Z',
          refreshTokenExpiresAt: '2026-09-19T12:00:00.000Z',
          userId: '1',
        });
      },
    });

    await client.login({ handle: 'sam', password: 'p', userAgent: 'Mozilla/5.0' });

    expect(seen).toBe('Mozilla/5.0');
  });

  /**
   * UNAUTHENTICATED becomes 401, and the response carries no `field` —
   * Identity deliberately attaches no violation to a rejected login, so
   * there is nothing here to turn into one. See
   * docs/concepts/access-and-refresh-tokens.md.
   */
  it('maps a rejected login to 401 with nothing naming which half was wrong', async () => {
    const client = await startIdentity({
      Login: (_call, callback) => {
        callback({ code: GrpcStatus.UNAUTHENTICATED, details: 'invalid handle or password' });
      },
    });

    const failure = client.login({ handle: 'nobody', password: 'wrong-one1', userAgent: '' });

    await expect(failure).rejects.toBeInstanceOf(ProblemDetailsException);

    const error = (await failure.catch((caught: unknown) => caught)) as ProblemDetailsException;
    expect(error.getStatus()).toBe(401);
    // The rendered body, not the instance: ProblemDetailsException always
    // declares `field`, and toBody() is what decides whether it reaches
    // the client. Asserting on the property would pass either way.
    expect(Object.keys(error.toBody())).not.toContain('field');
  });
});
