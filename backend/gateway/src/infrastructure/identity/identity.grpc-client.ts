import {
  credentials,
  loadPackageDefinition,
  type CallOptions,
  type ChannelCredentials,
  type Client,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  identityProtoPath,
  type IdentityServiceClient,
  type RegisterRequest,
  type RegisterResponse,
} from '@x-clone/proto';
import { FIRST_SERVER_ERROR_STATUS, toProblemDetails } from '../grpc/grpc-problem-details';

/**
 * Every call carries one. A gRPC call without a deadline waits forever by
 * default, and "forever" is not an abstraction: the Express request handler
 * behind it stays parked, holding its socket, and a downstream service that
 * hangs rather than fails takes the Gateway's connection pool with it.
 *
 * Five seconds is generous for a call whose slowest legitimate step is one
 * argon2id hash (~100ms by design). It is set high enough that only a real
 * fault trips it, which is what makes tripping it meaningful.
 */
const CALL_TIMEOUT_MS = 5_000;

/**
 * @grpc/proto-loader reads the .proto at runtime, so TypeScript knows
 * nothing about what comes back — hence the assertion. The shape asserted
 * here is `package identity.v1` + `service IdentityService` from
 * identity.proto; rename either in the .proto without changing this and
 * the failure is a TypeError at boot, not a compile error.
 */
interface IdentityProtoPackage {
  identity: {
    v1: {
      // Typed as returning the client we want, rather than grpc-js's generic
      // ServiceClient: the assertion is already unchecked, so making it say
      // the useful thing costs nothing and saves a second cast below.
      IdentityService: new (url: string, credentials: ChannelCredentials) => IdentityRpcClient;
    };
  };
}

type RegisterCall = (
  request: RegisterRequest,
  options: CallOptions,
  callback: (error: ServiceError | null, response?: RegisterResponse) => void,
) => void;

type IdentityRpcClient = Client & { register: RegisterCall };

/**
 * The Gateway's only way of reaching Identity.
 *
 * Implements the IdentityServiceClient interface from @x-clone/proto, which
 * is Promise-shaped — the callback API stops at this file's boundary.
 */
export class IdentityGrpcClient implements IdentityServiceClient, OnApplicationShutdown {
  private readonly client: IdentityRpcClient;

  constructor(url: string) {
    const definition = loadSync(identityProtoPath(), {
      // `display_name` in the .proto becomes `displayName` in JavaScript.
      // Both sides load the same file with the same setting, which is the
      // only reason RegisterResponse in @x-clone/proto can be camelCase.
      keepCase: false,
      // 64-bit fields as strings, never as JS numbers. No field in this
      // proto is one yet — ids are already declared `string` — but this is
      // the setting whose absence silently truncates a Snowflake the day
      // one is, and it costs nothing to be right about it now.
      longs: String,
      // A field the server left unset arrives as '' rather than undefined,
      // so `response.displayName` is a string in every branch.
      defaults: true,
      oneofs: true,
    });

    const proto = loadPackageDefinition(definition) as unknown as IdentityProtoPackage;

    // createInsecure: no TLS. Both ends sit on the compose bridge network,
    // and in Phase 11 this becomes the cluster's internal network. TLS
    // between services is a real thing to want; it is not a thing to fake
    // with self-signed certificates on a laptop.
    this.client = new proto.identity.v1.IdentityService(url, credentials.createInsecure());
  }

  register(request: RegisterRequest): Promise<RegisterResponse> {
    return new Promise<RegisterResponse>((resolve, reject) => {
      const options: CallOptions = { deadline: Date.now() + CALL_TIMEOUT_MS };

      this.client.register(request, options, (error, response) => {
        if (error !== null) {
          reject(this.asPublicFailure(error));
          return;
        }
        if (response === undefined) {
          // grpc-js types allow it; the protocol does not produce it.
          reject(this.asPublicFailure(new Error('identity returned no response')));
          return;
        }
        resolve(response);
      });
    });
  }

  /**
   * Nest only calls this if bootstrap enabled shutdown hooks. Without the
   * close, the channel's keepalive timers keep the event loop alive and
   * `docker stop` falls through to SIGKILL after its grace period.
   */
  onApplicationShutdown(): void {
    this.client.close();
  }

  private asPublicFailure(error: unknown): Error {
    const problem = toProblemDetails(error);

    // The one place the detail is not lost. Mirrors what Identity's own
    // controller does on its side, and for the same reason: the client is
    // about to receive a 5xx with nothing in it.
    if (problem.getStatus() >= FIRST_SERVER_ERROR_STATUS) {
      console.error('gateway: identity call failed', error);
    }

    return problem;
  }
}
