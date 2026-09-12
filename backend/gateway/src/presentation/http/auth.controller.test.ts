import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException } from '@x-clone/problem-details';
import type {
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
} from '@x-clone/proto';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';

const loginNotCalled = () => Promise.reject(new Error('login not exercised by this test'));
const registerNotCalled = () => Promise.reject(new Error('register not exercised by this test'));

/**
 * A plain function, not a mock of IdentityGrpcClient. Constructing the real
 * client opens a channel; the controller only ever needs something with a
 * `register` and a `login`, which is why it asks for Pick<...> of those.
 */
function controllerWith(register: (request: RegisterRequest) => Promise<RegisterResponse>) {
  const calls: RegisterRequest[] = [];
  const controller = new AuthController({
    register: (request) => {
      calls.push(request);
      return register(request);
    },
    login: loginNotCalled,
  });
  return { controller, calls };
}

function loginControllerWith(login: (request: LoginRequest) => Promise<LoginResponse>) {
  const calls: LoginRequest[] = [];
  const controller = new AuthController({
    register: registerNotCalled,
    login: (request) => {
      calls.push(request);
      return login(request);
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

const aTokenPair: LoginResponse = {
  accessToken: 'header.payload.signature',
  refreshToken: 'opaque-refresh-token',
  accessTokenExpiresAt: '2026-08-20T12:15:00.000Z',
  refreshTokenExpiresAt: '2026-09-19T12:00:00.000Z',
  userId: '1847100000001',
};

const CREDENTIALS = { handle: 'sam', password: 'correcthorse1' };

describe('AuthController.login', () => {
  it('forwards the credentials and returns both tokens', async () => {
    const { controller, calls } = loginControllerWith(() => Promise.resolve(aTokenPair));

    const response = await controller.login(CREDENTIALS, 'curl/8.4.0');

    expect(calls).toEqual([{ handle: 'sam', password: 'correcthorse1', userAgent: 'curl/8.4.0' }]);
    expect(response).toEqual({
      accessToken: 'header.payload.signature',
      accessTokenExpiresAt: '2026-08-20T12:15:00.000Z',
      refreshToken: 'opaque-refresh-token',
      refreshTokenExpiresAt: '2026-09-19T12:00:00.000Z',
      userId: '1847100000001',
    });
  });

  /**
   * proto3 has no null, so an absent header travels as ''. Identity turns
   * it back into a real NULL on the session row.
   */
  it('sends an empty user agent when the client sent no header', async () => {
    const { controller, calls } = loginControllerWith(() => Promise.resolve(aTokenPair));

    await controller.login(CREDENTIALS);

    expect(calls[0]?.userAgent).toBe('');
  });

  it('returns only the five public fields, whatever else the proto carries', async () => {
    const { controller } = loginControllerWith(() =>
      Promise.resolve({ ...aTokenPair, sessionId: '999' } as LoginResponse),
    );

    const response = await controller.login(CREDENTIALS);

    expect(Object.keys(response).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'refreshTokenExpiresAt',
      'userId',
    ]);
  });

  it('keeps the user id a string, so a Snowflake survives the trip to a browser', async () => {
    const { controller } = loginControllerWith(() => Promise.resolve(aTokenPair));

    const response = await controller.login(CREDENTIALS);

    expect(typeof response.userId).toBe('string');
  });

  it('rejects a malformed body without spending a call on Identity', async () => {
    const { controller, calls } = loginControllerWith(() => Promise.resolve(aTokenPair));

    const failure = controller.login({ handle: 'sam' });

    await expect(failure).rejects.toBeInstanceOf(ProblemDetailsException);
    expect(calls).toEqual([]);
  });

  /**
   * The 401 arrives already shaped by the gRPC client, with no `field`
   * and a message that does not say which half was wrong. The controller's
   * job is to not undo any of that — which it does by having no catch.
   */
  it('lets a rejected login through untouched', async () => {
    const unauthorized = new ProblemDetailsException({
      status: HttpStatus.UNAUTHORIZED,
      title: 'Unauthorized',
      detail: 'invalid handle or password',
    });
    const { controller } = loginControllerWith(() => Promise.reject(unauthorized));

    await expect(controller.login(CREDENTIALS)).rejects.toBe(unauthorized);
  });

  it('never lets the submitted password back out in a rejection', async () => {
    const { controller } = loginControllerWith(() => Promise.resolve(aTokenPair));

    const failure = controller.login({ handle: 'sam', password: 42 });
    const error = (await failure.catch((caught: unknown) => caught)) as ProblemDetailsException;

    expect(JSON.stringify(error.toBody())).not.toContain('42');
  });
});
