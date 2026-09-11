import { assertValidHandle } from '../domain/handle';
import { HandleTakenError } from '../domain/errors';
import { assertValidPassword } from '../domain/password';
import type { IdGenerator } from '../domain/ports/id-generator';
import type { PasswordHasher } from '../domain/ports/password-hasher';
import type { UserRepository } from '../domain/ports/user-repository';
import type { User } from '../domain/user';

export interface RegisterUserInput {
  handle: string;
  password: string;
}

/**
 * Orchestration only — every rule it enforces lives in domain/. Validation
 * runs before either dependency is touched, so a malformed request never
 * costs a hash (deliberately slow, by design of argon2id) or a query.
 */
export class RegisterUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: RegisterUserInput): Promise<User> {
    assertValidHandle(input.handle);
    assertValidPassword(input.password);

    if (await this.users.existsByHandle(input.handle)) {
      throw new HandleTakenError(input.handle);
    }

    const passwordHash = await this.hasher.hash(input.password);
    const user: User = {
      id: this.ids.next(),
      handle: input.handle,
      displayName: input.handle,
      createdAt: new Date(),
    };

    await this.users.create(user, passwordHash);

    return user;
  }
}
