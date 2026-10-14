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

  return {
    async beginLogin() {
      const config = await getConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authorizationUrl = oidc.buildAuthorizationUrl(config, {
        redirect_uri: options.redirectUri,
        scope: "openid profile",
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
      const name = typeof claims.name === "string" ? claims.name : undefined;
      return { issuer: claims.iss, subject: claims.sub, ...(name ? { displayName: name } : {}) };
    },
  };
}
