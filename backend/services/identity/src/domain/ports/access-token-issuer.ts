/**
 * What the Gateway learns from a token without asking anyone.
 *
 * `sessionId` rides along even though nothing in #6 reads it back. It is
 * what lets a future revocation check ask about *this* login rather than
 * about the account as a whole — and a claim added later would be absent
 * from every token already in circulation.
 */
export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Signing only. The lifetime is decided by the use case and arrives here
 * already resolved to an instant, so there is exactly one place in this
 * service that knows how long an access token lives.
 */
export interface AccessTokenIssuer {
  issue(claims: AccessTokenClaims): string;
}
