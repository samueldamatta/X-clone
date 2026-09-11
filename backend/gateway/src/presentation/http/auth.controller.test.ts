import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException } from '@x-clone/problem-details';
import type { RegisterRequest, RegisterResponse } from '@x-clone/proto';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';

/**
 * A plain function, not a mock of IdentityGrpcClient. Constructing the real
 * client opens a channel; the controller only ever needs something with a
 * `register`, which is why it asks for Pick<..., 'register'>.
 */
function controllerWith(register: (request: RegisterRequest) => Promise<RegisterResponse>) {
  const calls: RegisterRequest[] = [];
  const controller = new AuthController({
    register: (request) => {
      calls.push(request);
      return register(request);
    },
  });
  return { controller, calls };
}

const anAccount: RegisterResponse = {
  id: '1847362819999',
  handle: 'sam',
  displayName: 'sam',
  createdAt: '2026-08-20T12:00:00.000Z',
};

describe('AuthController.register', () => {
  it('forwards the credentials and returns the created account', async () => {
    const { controller, calls } = controllerWith(() => Promise.resolve(anAccount));

    const response = await controller.register({ handle: 'sam', password: 'correcthorse1' });

    expect(calls).toEqual([{ handle: 'sam', password: 'correcthorse1' }]);
    expect(response).toEqual({
      id: '1847362819999',
      handle: 'sam',
      displayName: 'sam',
      createdAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('keeps the id a string, so a Snowflake survives the trip to a browser', async () => {
    const { controller } = controllerWith(() => Promise.resolve(anAccount));

    const response = await controller.register({ handle: 'sam', password: 'correcthorse1' });

    expect(typeof response.id).toBe('string');
    // The value a JSON number would have silently become, above 2^53-1.
    expect(response.id).not.toBe(1847362819999);
  });

  it('returns only the four public fields, whatever else the proto carries', async () => {
    const { controller } = controllerWith(() =>
      Promise.resolve({ ...anAccount, internalFlag: true } as RegisterResponse),
    );

    const response = await controller.register({ handle: 'sam', password: 'correcthorse1' });

    expect(Object.keys(response).sort()).toEqual(['createdAt', 'displayName', 'handle', 'id']);
  });

  it('rejects a malformed body without spending a call on Identity', async () => {
    // The assertion that matters is `calls` staying empty: a round trip and
    // an argon2id hash are both deliberately expensive, and neither should
    // be spent on a request that was never well-formed.
    const { controller, calls } = controllerWith(() => Promise.resolve(anAccount));

    const failure = controller.register({ handle: 'sam' });

    await expect(failure).rejects.toBeInstanceOf(ProblemDetailsException);
    await expect(failure).rejects.toMatchObject({ field: 'password' });
    expect(calls).toEqual([]);
  });

  it('lets a failure from Identity through untouched', async () => {
    // Already a ProblemDetailsException by the time it leaves the gRPC
    // client. A catch here could only make it worse.
    const conflict = new ProblemDetailsException({
      status: HttpStatus.CONFLICT,
      title: 'Conflict',
      detail: 'handle "sam" is already taken',
      field: 'handle',
    });
    const { controller } = controllerWith(() => Promise.reject(conflict));

    await expect(controller.register({ handle: 'sam', password: 'correcthorse1' })).rejects.toBe(
      conflict,
    );
  });
});
