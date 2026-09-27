/**
 * One link in a session's chain. Spent rather than deleted when exchanged:
 * a spent row is what lets a replayed token be told apart from an unknown one.
 */
export interface StoredRefreshToken {
  readonly id: string;
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly spentAt: Date | null;
  readonly createdAt: Date;
}
