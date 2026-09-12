import { beforeEach, describe, expect, it } from 'vitest';
import { DomainValidationError, HandleTakenError } from '../domain/errors';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { PasswordHasher } from '../domain/ports/password-hasher';
import type { StoredCredentials, UserRepository } from '../domain/ports/user-repository';
import type { User } from '../domain/user';
import { RegisterUserUseCase } from './register-user.use-case';

class InMemoryUserRepository implements UserRepository {
  private readonly handles = new Set<string>();
  readonly created: { user: User; passwordHash: string }[] = [];

  seed(handle: string): void {
    this.handles.add(handle.toLowerCase());
  }

  existsByHandle(handle: string): Promise<boolean> {
    return Promise.resolve(this.handles.has(handle.toLowerCase()));
  }

  create(user: User, passwordHash: string): Promise<void> {
    this.handles.add(user.handle.toLowerCase());
    this.created.push({ user, passwordHash });
    return Promise.resolve();
  }

  /** Part of the port, and no part of registering. See login.use-case.test.ts. */
  findCredentialsByHandle(): Promise<StoredCredentials | undefined> {
    return Promise.reject(new Error('not used by RegisterUserUseCase'));
  }
}

class FakePasswordHasher implements PasswordHasher {
  readonly hashed: string[] = [];

  hash(password: string): Promise<string> {
    this.hashed.push(password);
    return Promise.resolve(`hashed:${password}`);
  }

  verify(): Promise<boolean> {
    return Promise.reject(new Error('not used by RegisterUserUseCase'));
  }
}

class FakeIdGenerator implements IdGenerator {
  #next = 0;

  next(): string {
    this.#next += 1;
    return this.#next.toString();
  }
}

function setup() {
  const repository = new InMemoryUserRepository();
  const hasher = new FakePasswordHasher();
  const ids = new FakeIdGenerator();
  const useCase = new RegisterUserUseCase(repository, hasher, ids);
  return { repository, hasher, ids, useCase };
}

describe('RegisterUserUseCase', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('creates a user with a minted id and hashed password', async () => {
    const user = await ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' });

    expect(user.createdAt).toBeInstanceOf(Date);
    expect({ ...user, createdAt: undefined }).toEqual({
      id: '1',
      handle: 'sam',
      displayName: 'sam',
      createdAt: undefined,
    });
    expect(ctx.hasher.hashed).toEqual(['correcthorse1']);
    expect(ctx.repository.created).toEqual([{ user, passwordHash: 'hashed:correcthorse1' }]);
  });

  it('rejects a handle already taken, ignoring case', async () => {
    ctx.repository.seed('Sam');

    await expect(ctx.useCase.execute({ handle: 'sam', password: 'correcthorse1' })).rejects.toThrow(
      HandleTakenError,
    );
    expect(ctx.repository.created).toEqual([]);
    expect(ctx.hasher.hashed).toEqual([]);
  });

  it('rejects a malformed handle before touching the repository or hasher', async () => {
    await expect(ctx.useCase.execute({ handle: 'a', password: 'correcthorse1' })).rejects.toThrow(
      DomainValidationError,
    );
    expect(ctx.repository.created).toEqual([]);
    expect(ctx.hasher.hashed).toEqual([]);
  });

  it('rejects a weak password before touching the repository or hasher', async () => {
    await expect(ctx.useCase.execute({ handle: 'sam', password: 'weak' })).rejects.toThrow(
      DomainValidationError,
    );
    expect(ctx.repository.created).toEqual([]);
    expect(ctx.hasher.hashed).toEqual([]);
  });
});
