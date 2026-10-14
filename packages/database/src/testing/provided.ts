/** Values the integration global setup hands to tests through Vitest's `inject`. */
export interface TestDatabaseUrls {
  admin: string;
  owner: string;
  api: string;
  worker: string;
  public: string;
}

/** Local OIDC settings from .env, for tests that drive the real development IdP. */
export interface TestOidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  consoleOrigin: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    testDatabase: TestDatabaseUrls;
    testOidc: TestOidcSettings | null;
  }
}
