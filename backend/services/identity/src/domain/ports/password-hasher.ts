export interface PasswordHasher {
  hash(password: string): Promise<string>;

  /**
   * False for a wrong password, never a throw — a wrong password is an
   * expected outcome of a working login, not a fault. An unreadable or
   * corrupt stored hash is a fault, and that one does throw.
   */
  verify(hash: string, password: string): Promise<boolean>;
}
