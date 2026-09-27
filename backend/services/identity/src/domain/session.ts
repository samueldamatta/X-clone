/** One login and the refresh-token chain minted from it; revoking it revokes every token at once. */
export interface Session {
  readonly id: string;
  readonly userId: string;
  /** Absolute: rotation never extends it, so a chain dies 30 days after its login. */
  readonly expiresAt: Date;
  /** Null until the session is revoked. */
  readonly revokedAt: Date | null;
  /** Whatever the client sent, or null. Never trusted, never parsed. */
  readonly userAgent: string | null;
  readonly createdAt: Date;
}
