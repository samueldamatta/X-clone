import { ProfileNotFoundError } from '../domain/errors';
import { assertValidHandle } from '../domain/handle';
import type { ProfileRepository } from '../domain/ports/profile-repository';
import type { Profile } from '../domain/profile';

/**
 * Reads a public profile by handle. No authentication, by design: a profile
 * page is the one thing in this system that exists to be seen by people who
 * are not logged in.
 *
 * Note that this *does* call assertValidHandle, where LoginUseCase
 * deliberately does not. The reason they differ is the whole point of both.
 * Login hides which handles exist, so a 400 for "too short" next to a 401
 * for "unknown" would tell an attacker which handles are merely
 * unregistered. This endpoint is an existence oracle on purpose — anyone
 * can ask it whether @sam is taken — so there is nothing left for the 400
 * to leak, and refusing a 2 KB path segment before it reaches Postgres is
 * simply free.
 */
export class GetProfileUseCase {
  constructor(private readonly profiles: ProfileRepository) {}

  async execute(handle: string): Promise<Profile> {
    assertValidHandle(handle);

    const profile = await this.profiles.findByHandle(handle);
    if (profile === undefined) {
      throw ProfileNotFoundError.byHandle(handle);
    }

    return profile;
  }
}
