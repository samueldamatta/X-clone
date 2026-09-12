export interface RefreshToken {
  /** Returned to the caller once, and never stored anywhere. */
  readonly token: string;
  /** The only half that reaches the database. */
  readonly hash: string;
}

/**
 * Minting and hashing are one port, not two, because the two halves have to
 * agree on an encoding to be of any use — a generator that returns base64url
 * and a hasher that digests the raw bytes would produce a hash that no later
 * lookup could reproduce. Keeping them together means that agreement is
 * internal to one implementation instead of an unwritten rule between two.
 */
export interface RefreshTokenFactory {
  create(): RefreshToken;
}
