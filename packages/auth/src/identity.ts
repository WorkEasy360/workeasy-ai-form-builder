/**
 * Identity-provider boundary (docs/06 §1). The application only ever sees a
 * verified issuer + subject pair; tenant membership is decided server-side
 * from our own records, never from email domain or unverified claims.
 */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  displayName?: string;
}

/** Opaque per-login state (PKCE verifier, state, nonce) kept by the caller between redirects. */
export interface LoginTransaction {
  codeVerifier: string;
  state: string;
  nonce: string;
  createdAt: number;
}

export interface IdentityProvider {
  /** Builds the authorization redirect and the state that must survive until the callback. */
  beginLogin(): Promise<{ authorizationUrl: URL; transaction: LoginTransaction }>;
  /** Validates the callback (state, nonce, code exchange, ID token) and returns the verified identity. */
  completeLogin(callbackUrl: URL, transaction: LoginTransaction): Promise<VerifiedIdentity>;
}
