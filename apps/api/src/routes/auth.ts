import { Router } from "express";
import type { IdentityProvider } from "@workeasy/auth";
import { identityRepo, type Db } from "@workeasy/database";
import type { Logger } from "@workeasy/observability";
import type { AppDependencies } from "../app.js";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies.js";
import { sendProblem } from "../http/problem.js";
import { requestLog } from "../http/request-context.js";
import { requireSameOrigin } from "../http/same-origin.js";
import { LOGIN_TRANSACTION_MAX_AGE_MS, sealLoginTransaction, unsealLoginTransaction } from "../identity/login-transaction.js";

/** `__Host-` binds the cookie to the exact console origin when it is served over HTTPS. */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-we_session" : "we_session";
}

/**
 * Respondents sign in on the respondent origin with their own cookie, never
 * the console's (docs/06 §1). Locally both origins are localhost, where
 * cookies ignore the port, so the names must differ.
 */
export function respondentSessionCookieName(secure: boolean): string {
  return secure ? "__Host-we_respondent" : "we_respondent";
}

interface SignInOptions {
  db: Db;
  logger: Logger;
  identityProvider: IdentityProvider;
  sessionSecret: string;
  sessionTtlMs: number;
  secure: boolean;
  /** The public origin the IdP redirects back to, and the only origin allowed to sign out. */
  origin: string;
  sessionCookie: string;
  loginCookie: string;
  /** Path the login cookie is scoped to: where /login and /callback are served on `origin`. */
  loginCookiePath: string;
  /** Where to go after signing in or out, given an already-validated returnTo. */
  home: (returnTo: string | undefined) => string;
  signInFailed: (returnTo: string | undefined) => string;
  /** Accepts a requested return path, or undefined to ignore it. */
  parseReturnTo: (raw: unknown) => string | undefined;
}

/** OIDC sign-in, callback and sign-out for one origin and cookie (docs/06 §1). */
function signInRouter(options: SignInOptions): Router {
  const { db, logger, identityProvider, secure, sessionCookie, loginCookie, loginCookiePath } = options;
  const router = Router();

  router.get("/login", async (req, res) => {
    const log = requestLog(res, logger);
    const returnTo = options.parseReturnTo(req.query.returnTo);
    let started;
    try {
      started = await identityProvider.beginLogin();
    } catch (err) {
      log.error({ err }, "identity provider unavailable");
      sendProblem(res, 503, "IDENTITY_PROVIDER_UNAVAILABLE", "Sign-in is temporarily unavailable");
      return;
    }
    res.append(
      "Set-Cookie",
      serializeCookie(loginCookie, sealLoginTransaction({ ...started.transaction, ...(returnTo ? { returnTo } : {}) }, options.sessionSecret), {
        path: loginCookiePath,
        secure,
        maxAgeSeconds: LOGIN_TRANSACTION_MAX_AGE_MS / 1000,
      }),
    );
    res.set("Cache-Control", "no-store");
    res.redirect(302, started.authorizationUrl.toString());
  });

  router.get("/callback", async (req, res) => {
    const log = requestLog(res, logger);
    res.set("Cache-Control", "no-store");
    // The login transaction is single use whatever the outcome.
    res.append("Set-Cookie", clearCookie(loginCookie, { path: loginCookiePath, secure }));
    const sealed = parseCookies(req.get("cookie")).get(loginCookie);
    const transaction = sealed ? unsealLoginTransaction(sealed, options.sessionSecret) : undefined;
    if (!transaction) {
      log.warn("sign-in callback without a valid login transaction");
      res.redirect(303, options.signInFailed(undefined));
      return;
    }
    // Checked again: the cookie is authentic, but the rules are the source of truth.
    const returnTo = options.parseReturnTo(transaction.returnTo);
    try {
      // The IdP redirected the browser to the public origin, which forwards here.
      const callbackUrl = new URL(req.originalUrl, options.origin);
      const identity = await identityProvider.completeLogin(callbackUrl, transaction);
      const userId = await identityRepo.findOrCreateUser(db, identity);
      const session = await identityRepo.createSession(db, userId, options.sessionTtlMs);
      res.append(
        "Set-Cookie",
        serializeCookie(sessionCookie, session.token, { path: "/", secure, maxAgeSeconds: options.sessionTtlMs / 1000 }),
      );
      log.info({ userId, sessionId: session.sessionId }, "user signed in");
      res.redirect(303, options.home(returnTo));
    } catch (err) {
      // Log the failure class only; never tokens, codes or claims.
      log.warn({ err }, "sign-in failed");
      res.redirect(303, options.signInFailed(returnTo));
    }
  });

  router.post("/logout", requireSameOrigin(options.origin), async (req, res) => {
    const log = requestLog(res, logger);
    const token = parseCookies(req.get("cookie")).get(sessionCookie);
    const session = token ? await identityRepo.resolveSession(db, token) : undefined;
    if (session) {
      await identityRepo.revokeSession(db, session);
      log.info({ userId: session.userId, sessionId: session.sessionId }, "user signed out");
    }
    res.append("Set-Cookie", clearCookie(sessionCookie, { path: "/", secure }));
    res.set("Cache-Control", "no-store");
    res.redirect(303, options.home(options.parseReturnTo(req.query.returnTo)));
  });

  return router;
}

/** Console sign-in at /auth on the console origin. */
export function authRouter({ db, identityProvider, settings, logger }: AppDependencies): Router {
  const secure = settings.secureCookies;
  return signInRouter({
    db,
    logger,
    identityProvider,
    sessionSecret: settings.sessionSecret,
    sessionTtlMs: settings.sessionTtlMs,
    secure,
    origin: settings.consoleOrigin,
    sessionCookie: sessionCookieName(secure),
    loginCookie: secure ? "__Secure-we_login" : "we_login",
    loginCookiePath: "/auth",
    home: () => new URL("/", settings.consoleOrigin).toString(),
    signInFailed: () => new URL("/?signin=failed", settings.consoleOrigin).toString(),
    parseReturnTo: () => undefined,
  });
}

/** Form pages a respondent may be sent back to after signing in: `/f/<slug>`, optionally embedded. */
const FORM_RETURN_PATH = /^\/f\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9](\?embed=1)?$/;

/**
 * Respondent sign-in at /public/v1/auth on the respondent origin, for
 * organization-only forms. Only form pages are accepted as return paths, so
 * the flow can never redirect anywhere else.
 */
export function respondentAuthRouter({ db, respondentIdentityProvider, settings, logger }: AppDependencies): Router {
  const secure = settings.secureCookies;
  const home = (returnTo: string | undefined) => new URL(returnTo ?? "/", settings.respondentOrigin).toString();
  return signInRouter({
    db,
    logger,
    identityProvider: respondentIdentityProvider,
    sessionSecret: settings.sessionSecret,
    sessionTtlMs: settings.sessionTtlMs,
    secure,
    origin: settings.respondentOrigin,
    sessionCookie: respondentSessionCookieName(secure),
    loginCookie: secure ? "__Secure-we_respondent_login" : "we_respondent_login",
    loginCookiePath: "/public/v1/auth",
    home,
    signInFailed: (returnTo) => {
      const url = new URL(home(returnTo));
      url.searchParams.set("signin", "failed");
      return url.toString();
    },
    parseReturnTo: (raw) => (typeof raw === "string" && FORM_RETURN_PATH.test(raw) ? raw : undefined),
  });
}
