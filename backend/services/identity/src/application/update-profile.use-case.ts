import { EmptyProfileUpdateError, ProfileNotFoundError } from '../domain/errors';
import type { ProfileRepository } from '../domain/ports/profile-repository';
import { normalizeBio, normalizeDisplayName, type Profile } from '../domain/profile';
import type { ProfileChanges } from '../domain/profile';

/**
 * Note what is missing: any way to say whose profile this is, other than
 * `userId`. That is not an omission — it is the mechanism.
 *
 * The acceptance criterion "an authenticated account cannot update anyone
 * else's profile" could be met by comparing a token's subject against an id
 * in the request. This use case meets it by having nowhere to put the other
 * id. There is no check to forget, because there is no check: `userId`
 * arrives from a verified access token, and the request body has no field
 * that could contradict it.
 *
 * The price: an administrator who one day needs to edit someone else's
 * profile needs a new use case, not a different argument. That is the right
 * shape for that feature anyway — it is a different permission.
 */
export interface UpdateProfileInput {
  /** From the access token the Gateway verified. Never from the body. */
  userId: string;
  /** Absent means "leave it alone". '' is a value, and clears the field. */
  displayName?: string;
  bio?: string;
}

export class UpdateProfileUseCase {
  constructor(private readonly profiles: ProfileRepository) {}

  async execute(input: UpdateProfileInput): Promise<Profile> {
    const changes: ProfileChanges = {};

    // `!== undefined`, never a truthiness check. `if (input.bio)` would skip
    // '' — and '' is exactly the request to clear a bio, so the one field
    // update the shorthand drops is the one a person had to type nothing to
    // ask for.
    if (input.displayName !== undefined) {
      changes.displayName = normalizeDisplayName(input.displayName);
    }
    if (input.bio !== undefined) {
      changes.bio = normalizeBio(input.bio);
    }

    // Before the write, not after: an UPDATE with an empty SET is not a
    // no-op, it is a syntax error, and the caller deserves to be told what
    // they did rather than handed a database complaint.
    if (Object.keys(changes).length === 0) {
      throw new EmptyProfileUpdateError();
    }

    const profile = await this.profiles.update(input.userId, changes);
    if (profile === undefined) {
      throw ProfileNotFoundError.byId(input.userId);
    }

    return profile;
  }
}
