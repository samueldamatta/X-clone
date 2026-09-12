import 'reflect-metadata';
import { ProblemDetailsException } from '@x-clone/problem-details';
import type { GetProfileRequest, Profile, UpdateProfileRequest } from '@x-clone/proto';
import { describe, expect, it } from 'vitest';
import type { VerifiedAccessToken } from '../../infrastructure/security/hs256-access-token-verifier';
import { AccessTokenGuard } from './access-token.guard';
import { UsersController } from './users.controller';

const SAM: Profile = {
  id: '1847100000001',
  handle: 'sam',
  displayName: 'Sam',
  bio: 'building a twitter clone',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const PRINCIPAL: VerifiedAccessToken = {
  userId: SAM.id,
  sessionId: '1847100000002',
  expiresAt: new Date('2026-09-12T12:15:00.000Z'),
};

const getProfileNotCalled = () => Promise.reject(new Error('getProfile not exercised here'));
const updateProfileNotCalled = () => Promise.reject(new Error('updateProfile not exercised here'));

function readControllerWith(getProfile: (request: GetProfileRequest) => Promise<Profile>) {
  const calls: GetProfileRequest[] = [];
  const controller = new UsersController({
    getProfile: (request) => {
      calls.push(request);
      return getProfile(request);
    },
    updateProfile: updateProfileNotCalled,
  });
  return { controller, calls };
}

function updateControllerWith(
  updateProfile: (request: UpdateProfileRequest) => Promise<Profile> = () => Promise.resolve(SAM),
) {
  const calls: UpdateProfileRequest[] = [];
  const controller = new UsersController({
    getProfile: getProfileNotCalled,
    updateProfile: (request) => {
      calls.push(request);
      return updateProfile(request);
    },
  });
  return { controller, calls };
}

describe('GET /v1/users/{handle}', () => {
  it('returns the profile, field by field', async () => {
    const { controller } = readControllerWith(() => Promise.resolve(SAM));

    expect(await controller.profile('sam')).toEqual({
      id: '1847100000001',
      handle: 'sam',
      displayName: 'Sam',
      bio: 'building a twitter clone',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('forwards the handle from the path, untouched', async () => {
    const { controller, calls } = readControllerWith(() => Promise.resolve(SAM));

    await controller.profile('SaM');

    // Not lower-cased here: case-insensitivity is the CITEXT column's job,
    // and normalising in two places means two rules that can drift.
    expect(calls).toEqual([{ handle: 'SaM' }]);
  });

  it('strips anything the .proto grows that the public API has not agreed to', async () => {
    const withExtra = { ...SAM, followerCount: 12, internalNote: 'do-not-publish' };
    const { controller } = readControllerWith(() => Promise.resolve(withExtra as Profile));

    const response = await controller.profile('sam');

    expect(Object.keys(response).sort()).toEqual([
      'bio',
      'createdAt',
      'displayName',
      'handle',
      'id',
    ]);
    expect(JSON.stringify(response)).not.toContain('do-not-publish');
  });

  it('exposes an id that is not the handle, so a rename breaks no reference', async () => {
    const { controller } = readControllerWith(() => Promise.resolve(SAM));

    const response = await controller.profile('sam');

    expect(typeof response.id).toBe('string');
    expect(response.id).not.toBe(response.handle);
  });

  it('lets a not-found from Identity through untouched', async () => {
    // The Gateway adds no rule of its own: the gRPC client already
    // translated NOT_FOUND into a 404 ProblemDetailsException.
    const notFound = new ProblemDetailsException({ status: 404, title: 'Not Found' });
    const { controller } = readControllerWith(() => Promise.reject(notFound));

    await expect(controller.profile('nobody')).rejects.toBe(notFound);
  });
});

describe('PATCH /v1/users/me', () => {
  it('takes the subject from the token and nothing else', async () => {
    const { controller, calls } = updateControllerWith();

    await controller.updateOwnProfile(PRINCIPAL, { displayName: 'Samuel' });

    expect(calls).toEqual([{ userId: SAM.id, displayName: 'Samuel' }]);
  });

  it('ignores an id in the body: there is no field that could override the token', async () => {
    const { controller, calls } = updateControllerWith();

    await controller.updateOwnProfile(PRINCIPAL, {
      userId: '999',
      id: '999',
      handle: 'someone-else',
      displayName: 'Samuel',
    });

    // The acceptance criterion "cannot update anyone else's profile",
    // asserted where it is actually decided. Not a permission check that
    // passed — a request that had nowhere to say it.
    expect(calls[0]?.userId).toBe(PRINCIPAL.userId);
  });

  it('leaves an omitted field omitted all the way to the wire', async () => {
    const { controller, calls } = updateControllerWith();

    await controller.updateOwnProfile(PRINCIPAL, { displayName: 'Samuel' });

    expect('bio' in (calls[0] ?? {})).toBe(false);
  });

  it('carries an empty bio through as a value', async () => {
    const { controller, calls } = updateControllerWith();

    await controller.updateOwnProfile(PRINCIPAL, { bio: '' });

    expect(calls[0]).toEqual({ userId: SAM.id, bio: '' });
  });

  it('returns the profile as it now stands, so normalisation is visible', async () => {
    const { controller } = updateControllerWith(() =>
      Promise.resolve({ ...SAM, displayName: 'Samuel' }),
    );

    // The client sent '  Samuel  '; Identity trimmed it. Answering 204
    // would leave the client believing it stored the spaces.
    const response = await controller.updateOwnProfile(PRINCIPAL, { displayName: '  Samuel  ' });

    expect(response.displayName).toBe('Samuel');
  });

  it('refuses a malformed body before calling Identity', async () => {
    const { controller, calls } = updateControllerWith();

    await expect(controller.updateOwnProfile(PRINCIPAL, { displayName: 42 })).rejects.toThrow(
      ProblemDetailsException,
    );

    expect(calls).toHaveLength(0);
  });

  it('sends an empty patch on to Identity, which owns that rule', async () => {
    const { controller, calls } = updateControllerWith();

    await controller.updateOwnProfile(PRINCIPAL, {});

    // One network hop later than the Gateway could refuse it, and in the
    // one place that owns the rule — same trade as parseRegisterBody not
    // restating the password policy.
    expect(calls).toEqual([{ userId: SAM.id }]);
  });
});

/**
 * The guard is applied with a decorator rather than globally, which buys a
 * visible requirement at each route and costs one thing: a new
 * authenticated route that forgets `@UseGuards` fails *open*, and nothing
 * about it looks wrong. app.module.ts names that cost; this is what pays
 * it. It reads Nest's own route metadata, so it fails the moment the
 * decorator is removed — however healthy every other test here stays.
 */
describe('which routes are guarded', () => {
  /** Nest's key for @UseGuards metadata. A string, so no import of an internal. */
  const GUARDS_METADATA = '__guards__';

  /**
   * Read through the property descriptor rather than as
   * `UsersController.prototype.updateOwnProfile`. @UseGuards stores its
   * metadata on the handler function itself, and reaching that function as
   * a bare method reference is what `@typescript-eslint/unbound-method`
   * exists to warn about — rightly, since such a reference has lost its
   * receiver. The descriptor says "the function on this property", which is
   * what is meant.
   */
  function guardsOn(route: string): unknown[] {
    const handler = Object.getOwnPropertyDescriptor(UsersController.prototype, route)?.value as
      | object
      | undefined;

    expect(handler, `UsersController has no ${route}`).toBeDefined();

    return (Reflect.getMetadata(GUARDS_METADATA, handler as object) ?? []) as unknown[];
  }

  it('guards PATCH /v1/users/me', () => {
    expect(guardsOn('updateOwnProfile')).toContain(AccessTokenGuard);
  });

  it('leaves GET /v1/users/{handle} open, because a profile is public', () => {
    expect(guardsOn('profile')).toEqual([]);
  });

  it('guards nothing at the controller level, so each route states its own rule', () => {
    expect((Reflect.getMetadata(GUARDS_METADATA, UsersController) ?? []) as unknown[]).toEqual([]);
  });
});
