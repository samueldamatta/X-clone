import { beforeEach, describe, expect, it } from 'vitest';
import {
  DomainValidationError,
  EmptyProfileUpdateError,
  ProfileNotFoundError,
} from '../domain/errors';
import type { ProfileRepository } from '../domain/ports/profile-repository';
import type { Profile, ProfileChanges } from '../domain/profile';
import { GetProfileUseCase } from './get-profile.use-case';
import { UpdateProfileUseCase } from './update-profile.use-case';

const SAM: Profile = {
  id: '1847100000001',
  handle: 'sam',
  displayName: 'Sam',
  bio: 'building a twitter clone',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

class InMemoryProfileRepository implements ProfileRepository {
  private readonly byId = new Map<string, Profile>();

  /** Every call to update(), in order — the assertion surface for what reached SQL. */
  readonly updates: { userId: string; changes: ProfileChanges }[] = [];

  seed(profile: Profile): void {
    this.byId.set(profile.id, profile);
  }

  findByHandle(handle: string): Promise<Profile | undefined> {
    // Case-insensitive, standing in for the CITEXT column the real one uses.
    const match = [...this.byId.values()].find(
      (profile) => profile.handle.toLowerCase() === handle.toLowerCase(),
    );
    return Promise.resolve(match);
  }

  update(userId: string, changes: ProfileChanges): Promise<Profile | undefined> {
    this.updates.push({ userId, changes });

    const existing = this.byId.get(userId);
    if (existing === undefined) {
      return Promise.resolve(undefined);
    }

    const updated: Profile = { ...existing, ...changes };
    this.byId.set(userId, updated);
    return Promise.resolve(updated);
  }
}

let profiles: InMemoryProfileRepository;

beforeEach(() => {
  profiles = new InMemoryProfileRepository();
  profiles.seed(SAM);
});

describe('GetProfileUseCase', () => {
  it('returns the profile for a known handle', async () => {
    const profile = await new GetProfileUseCase(profiles).execute('sam');

    expect(profile).toEqual(SAM);
  });

  it('finds a handle whatever its case, the way the CITEXT column does', async () => {
    const profile = await new GetProfileUseCase(profiles).execute('SAM');

    expect(profile.id).toBe(SAM.id);
  });

  it('exposes an id alongside the handle, so a rename does not break references', async () => {
    const profile = await new GetProfileUseCase(profiles).execute('sam');

    // A string, never a number: a Snowflake above 2^53-1 does not survive
    // JSON's number type — docs/adr/0005-snowflake-ids.md.
    expect(typeof profile.id).toBe('string');
    expect(profile.id).not.toBe(profile.handle);
  });

  it('raises not-found for a handle nobody holds', async () => {
    await expect(new GetProfileUseCase(profiles).execute('nobody')).rejects.toThrow(
      ProfileNotFoundError,
    );
  });

  it('rejects a malformed handle before touching the repository', async () => {
    // Unlike login, which deliberately does not validate — see the comment
    // on this use case for why the two differ.
    await expect(new GetProfileUseCase(profiles).execute('a'.repeat(500))).rejects.toThrow(
      DomainValidationError,
    );
  });
});

describe('UpdateProfileUseCase', () => {
  it('updates the display name and returns the profile as it now stands', async () => {
    const profile = await new UpdateProfileUseCase(profiles).execute({
      userId: SAM.id,
      displayName: 'Samuel',
    });

    expect(profile.displayName).toBe('Samuel');
    expect(profile.bio).toBe(SAM.bio);
  });

  it('leaves an omitted field alone rather than clearing it', async () => {
    await new UpdateProfileUseCase(profiles).execute({ userId: SAM.id, displayName: 'Samuel' });

    // The key must be absent from the patch, not present and undefined:
    // "the object has no such key" is the rule that protects the bio, not
    // "the driver happens to ignore undefined".
    expect(profiles.updates[0]?.changes).toEqual({ displayName: 'Samuel' });
    expect('bio' in (profiles.updates[0]?.changes ?? {})).toBe(false);
  });

  it('treats an empty bio as a value, and clears it', async () => {
    const profile = await new UpdateProfileUseCase(profiles).execute({
      userId: SAM.id,
      bio: '',
    });

    expect(profile.bio).toBe('');
    expect(profiles.updates[0]?.changes).toEqual({ bio: '' });
  });

  it('changes both fields at once', async () => {
    const profile = await new UpdateProfileUseCase(profiles).execute({
      userId: SAM.id,
      displayName: 'Samuel',
      bio: 'hello',
    });

    expect(profile).toMatchObject({ displayName: 'Samuel', bio: 'hello' });
  });

  it('normalises before writing, so the trimmed value is what is stored', async () => {
    const profile = await new UpdateProfileUseCase(profiles).execute({
      userId: SAM.id,
      displayName: '  Samuel  ',
    });

    expect(profile.displayName).toBe('Samuel');
    expect(profiles.updates[0]?.changes.displayName).toBe('Samuel');
  });

  it('rejects an invalid display name without writing anything', async () => {
    await expect(
      new UpdateProfileUseCase(profiles).execute({ userId: SAM.id, displayName: '   ' }),
    ).rejects.toThrow(DomainValidationError);

    expect(profiles.updates).toHaveLength(0);
  });

  it('rejects a patch that asks for nothing, rather than answering 200 to a typo', async () => {
    await expect(new UpdateProfileUseCase(profiles).execute({ userId: SAM.id })).rejects.toThrow(
      EmptyProfileUpdateError,
    );

    expect(profiles.updates).toHaveLength(0);
  });

  it('raises not-found when the account behind a valid token is gone', async () => {
    await expect(
      new UpdateProfileUseCase(profiles).execute({ userId: '999', displayName: 'Ghost' }),
    ).rejects.toThrow(ProfileNotFoundError);
  });

  it('writes only to the account the token names', async () => {
    profiles.seed({ ...SAM, id: '1847100000002', handle: 'other', displayName: 'Other' });

    await new UpdateProfileUseCase(profiles).execute({ userId: SAM.id, displayName: 'Samuel' });

    // There is no argument that could have named the other account. This
    // asserts the mechanism rather than a permission check, because the
    // mechanism is the permission check.
    expect(profiles.updates.map((update) => update.userId)).toEqual([SAM.id]);
    await expect(new GetProfileUseCase(profiles).execute('other')).resolves.toMatchObject({
      displayName: 'Other',
    });
  });
});
