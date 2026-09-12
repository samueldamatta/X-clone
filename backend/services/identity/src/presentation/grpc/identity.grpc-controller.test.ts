import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { readFieldViolation } from '@x-clone/proto';
import { describe, expect, it } from 'vitest';
import type { LoginInput, LoginResult } from '../../application/login.use-case';
import {
  DomainValidationError,
  HandleTakenError,
  InvalidCredentialsError,
} from '../../domain/errors';
import type { User } from '../../domain/user';
import { IdentityGrpcController } from './identity.grpc-controller';

const neverCalled = {
  execute: () => Promise.reject(new Error('not exercised by this test')),
};

function controllerWith(execute: (input: { handle: string; password: string }) => Promise<User>) {
  return new IdentityGrpcController({ execute }, neverCalled);
}

function loginControllerWith(execute: (input: LoginInput) => Promise<LoginResult>) {
  return new IdentityGrpcController(neverCalled, { execute });
}

/** Pulls the RpcException's payload out, which is where the code lives. */
function rpcBody(error: unknown): {
  code: number;
  message: string;
  metadata?: import('@grpc/grpc-js').Metadata;
} {
  return (error as RpcException).getError() as {
    code: number;
    message: string;
    metadata?: import('@grpc/grpc-js').Metadata;
  };
}

describe('IdentityGrpcController.register', () => {
  it('maps the created user to a wire response with an ISO timestamp', async () => {
    const createdAt = new Date('2026-08-20T12:00:00.000Z');
    const controller = controllerWith(() =>
      Promise.resolve({ id: '123', handle: 'sam', displayName: 'sam', createdAt }),
    );

    const response = await controller.register({ handle: 'sam', password: 'correcthorse1' });

    expect(response).toEqual({
      id: '123',
      handle: 'sam',
      displayName: 'sam',
      createdAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('maps DomainValidationError to INVALID_ARGUMENT with a field violation', async () => {
    const controller = controllerWith(() => {
      throw new DomainValidationError('password', 'must be at least 8 characters');
    });

    const failure = controller.register({ handle: 'sam', password: 'x' });

    await expect(failure).rejects.toBeInstanceOf(RpcException);
    try {
      await failure;
      expect.unreachable();
    } catch (error) {
      const rpc = error as RpcException;
      const body = rpc.getError() as {
        code: number;
        message: string;
        metadata: import('@grpc/grpc-js').Metadata;
      };
      expect(body.code).toBe(GrpcStatus.INVALID_ARGUMENT);
      expect(readFieldViolation(body.metadata)).toEqual({
        field: 'password',
        reason: 'must be at least 8 characters',
      });
    }
  });

  it('maps HandleTakenError to ALREADY_EXISTS with a field violation', async () => {
    const controller = controllerWith(() => {
      throw new HandleTakenError('sam');
    });

    try {
      await controller.register({ handle: 'sam', password: 'correcthorse1' });
      expect.unreachable();
    } catch (error) {
      const rpc = error as RpcException;
      const body = rpc.getError() as {
        code: number;
        message: string;
        metadata: import('@grpc/grpc-js').Metadata;
      };
      expect(body.code).toBe(GrpcStatus.ALREADY_EXISTS);
      expect(readFieldViolation(body.metadata)?.field).toBe('handle');
    }
  });

  it('maps an unexpected error to INTERNAL with no leaked detail', async () => {
    const controller = controllerWith(() => {
      throw new Error('connection reset, credentials leaked in this message');
    });

    try {
      await controller.register({ handle: 'sam', password: 'correcthorse1' });
      expect.unreachable();
    } catch (error) {
      const rpc = error as RpcException;
      const body = rpc.getError() as { code: number; message: string };
      expect(body.code).toBe(GrpcStatus.INTERNAL);
      expect(body.message).toBe('internal error');
    }
  });
});

const LOGIN_RESULT: LoginResult = {
  userId: '900',
  sessionId: '1',
  accessToken: 'header.payload.signature',
  accessTokenExpiresAt: new Date('2026-08-20T12:15:00.000Z'),
  refreshToken: 'opaque-token',
  refreshTokenExpiresAt: new Date('2026-09-19T12:00:00.000Z'),
};

describe('IdentityGrpcController.login', () => {
  it('maps a successful login to a wire response with ISO timestamps', async () => {
    const controller = loginControllerWith(() => Promise.resolve(LOGIN_RESULT));

    const response = await controller.login({
      handle: 'sam',
      password: 'correcthorse1',
      userAgent: 'curl/8.4.0',
    });

    expect(response).toEqual({
      accessToken: 'header.payload.signature',
      refreshToken: 'opaque-token',
      accessTokenExpiresAt: '2026-08-20T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-19T12:00:00.000Z',
      userId: '900',
    });
  });

  /**
   * The session id stays on this side of the wire. It is in the JWT's
   * `sid` claim, where the Gateway will read it; repeating it in the
   * response body would publish an internal handle nobody outside needs.
   */
  it('does not put the session id in the response', async () => {
    const controller = loginControllerWith(() => Promise.resolve(LOGIN_RESULT));

    const response = await controller.login({ handle: 'sam', password: 'p', userAgent: '' });

    expect(Object.keys(response)).not.toContain('sessionId');
  });

  it('forwards the user agent to the use case', async () => {
    const seen: LoginInput[] = [];
    const controller = loginControllerWith((input) => {
      seen.push(input);
      return Promise.resolve(LOGIN_RESULT);
    });

    await controller.login({ handle: 'sam', password: 'p', userAgent: 'curl/8.4.0' });

    expect(seen[0]?.userAgent).toBe('curl/8.4.0');
  });

  /**
   * proto3 has no null, so an absent User-Agent arrives as ''. Passing
   * that through would store an empty string in a nullable column — a
   * value that reads as "the client sent an empty User-Agent" rather than
   * "the client sent none".
   */
  it('turns an empty user agent back into no user agent at all', async () => {
    const seen: LoginInput[] = [];
    const controller = loginControllerWith((input) => {
      seen.push(input);
      return Promise.resolve(LOGIN_RESULT);
    });

    await controller.login({ handle: 'sam', password: 'p', userAgent: '' });

    expect(seen[0]?.userAgent).toBeUndefined();
  });

  it('maps InvalidCredentialsError to UNAUTHENTICATED', async () => {
    const controller = loginControllerWith(() => {
      throw new InvalidCredentialsError();
    });

    try {
      await controller.login({ handle: 'sam', password: 'wrong', userAgent: '' });
      expect.unreachable();
    } catch (error) {
      expect(rpcBody(error).code).toBe(GrpcStatus.UNAUTHENTICATED);
    }
  });

  /**
   * The acceptance criterion, at the layer that could still leak it. A
   * field violation here would name `handle` or `password` and answer the
   * question the whole design refuses to answer.
   */
  it('attaches no field violation to a rejected login', async () => {
    const controller = loginControllerWith(() => {
      throw new InvalidCredentialsError();
    });

    try {
      await controller.login({ handle: 'nobody', password: 'correcthorse1', userAgent: '' });
      expect.unreachable();
    } catch (error) {
      const body = rpcBody(error);
      // No metadata at all, so there is nothing for the Gateway's
      // readFieldViolation to find and turn into a `field` member.
      expect(body.metadata).toBeUndefined();
      // Nothing in the message narrows it down to one of the two causes.
      expect(body.message).toBe('invalid handle or password');
      expect(body.message).not.toContain('nobody');
    }
  });

  it('maps an unexpected error to INTERNAL without leaking its detail', async () => {
    const controller = loginControllerWith(() => {
      throw new Error('postgres://identity_svc:hunter2@postgres:5432 refused');
    });

    try {
      await controller.login({ handle: 'sam', password: 'correcthorse1', userAgent: '' });
      expect.unreachable();
    } catch (error) {
      const body = rpcBody(error);
      expect(body.code).toBe(GrpcStatus.INTERNAL);
      expect(body.message).toBe('internal error');
      expect(body.message).not.toContain('hunter2');
    }
  });
});
