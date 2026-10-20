import type { IdentityProvider, VerifiedIdentity } from "@workeasy/auth";
import * as oidc from "openid-client";

export interface OidcProviderOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Allow plain-HTTP issuers; only for the local development provider. */
  allowInsecureRequests: boolean;
}

/**
 * OIDC authorization-code flow with PKCE, state and nonce (docs/06 §1).
 * openid-client validates issuer, audience, signature, expiry and nonce of the
 * ID token during the code exchange.
 */
export function createOidcIdentityProvider(options: OidcProviderOptions): IdentityProvider {
  let configuration: Promise<oidc.Configuration> | undefined;

  function getConfiguration(): Promise<oidc.Configuration> {
    configuration ??= oidc
      .discovery(
        new URL(options.issuerUrl),
        options.clientId,
        { redirect_uris: [options.redirectUri], response_types: ["code"] },
        oidc.ClientSecretBasic(options.clientSecret),
        options.allowInsecureRequests ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((err: unknown) => {
        // Retry discovery on the next sign-in instead of caching the failure.
        configuration = undefined;
        throw err;
      });
    return configuration;
  }

  let lastFailure = 0;

  return {
    async isAvailable() {
      // Discovery is cached once it succeeds; after a failure, retry at most once a minute.
      if (configuration === undefined && Date.now() - lastFailure < 60_000) return false;
      try {
        await getConfiguration();
        return true;
      } catch {
        lastFailure = Date.now();
        return false;
      }
    },

    async beginLogin() {
      const config = await getConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authorizationUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: options.redirectUri,
        scope: "openid profile email",
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { authorizationUrl, transaction: { codeVerifier, state, nonce, createdAt: Date.now() } };
    },

    async completeLogin(callbackUrl, transaction): Promise<VerifiedIdentity> {
      const config = await getConfiguration();
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error("The identity provider returned no ID token.");
      // Providers with email sign-up (e.g. Amazon Cognito) often have no name; show the address instead.
      const name = typeof claims.name === "string" ? claims.name : typeof claims.email === "string" ? claims.email.slice(0, 200) : undefined;
      return { issuer: claims.iss, subject: claims.sub, ...(name ? { displayName: name } : {}) };
    },
  };
}
