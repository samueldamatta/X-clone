/**
 * One login, as a row that outlives the request that created it — and the
 * chain every refresh token minted from that login belongs to.
 *
 * No token lives here. Each one is a StoredRefreshToken pointing back at
 * this id, so rotating a token never changes which session it is, and
 * revoking the session revokes every token in the chain at once.
 */
export interface Session {
  readonly id: string;
  readonly userId: string;
  /** Absolute: rotation never extends it, so a chain dies 30 days after its login. */
  readonly expiresAt: Date;
  /** Null until #9's logout or reuse detection sets it. */
  readonly revokedAt: Date | null;
  /** Whatever the client sent, or null. Never trusted, never parsed. */
  readonly userAgent: string | null;
  readonly createdAt: Date;
}
