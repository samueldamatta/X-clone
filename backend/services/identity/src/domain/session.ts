/**
 * One login, as a row that outlives the request that created it.
 *
 * The refresh token is deliberately absent: this entity holds only its
 * hash, and the token itself exists exactly once — in the response to the
 * login that minted it. If it is lost, it is lost; nothing here can
 * reconstruct it, which is the point.
 */
export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly refreshTokenHash: string;
  readonly expiresAt: Date;
  /** Null until #9's logout or #8's reuse detection sets it. */
  readonly revokedAt: Date | null;
  /** Whatever the client sent, or null. Never trusted, never parsed. */
  readonly userAgent: string | null;
  readonly createdAt: Date;
}
