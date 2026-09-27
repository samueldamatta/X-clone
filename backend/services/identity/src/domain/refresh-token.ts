/** Spent rather than deleted, so a replayed token is recognised as a replay and not as unknown. */
export interface StoredRefreshToken {
  readonly id: string;
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly spentAt: Date | null;
  readonly createdAt: Date;
}
