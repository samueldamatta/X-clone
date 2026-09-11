import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { readFieldViolation } from '@x-clone/proto';
import { describe, expect, it } from 'vitest';
import { DomainValidationError, HandleTakenError } from '../../domain/errors';
import type { User } from '../../domain/user';
import { IdentityGrpcController } from './identity.grpc-controller';

function controllerWith(execute: (input: { handle: string; password: string }) => Promise<User>) {
  return new IdentityGrpcController({ execute });
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
