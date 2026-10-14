import { Router } from "express";
import { identityRepo } from "@workeasy/database";
import type { AppDependencies } from "../app.js";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies.js";
import { sendProblem } from "../http/problem.js";
import { requestLog } from "../http/request-context.js";
import { requireSameOrigin } from "../http/same-origin.js";
import {
  LOGIN_TRANSACTION_MAX_AGE_MS,
  sealLoginTransaction,
  unsealLoginTransaction,
} from "../identity/login-transaction.js";

/** `__Host-` binds the cookie to the exact console origin when it is served over HTTPS. */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-we_session" : "we_session";
}

function loginCookieName(secure: boolean): string {
  return secure ? "__Secure-we_login" : "we_login";
}

const LOGIN_COOKIE_PATH = "/auth";

export function authRouter({ db, identityProvider, settings, logger }: AppDependencies): Router {
  const router = Router();
  const secure = settings.secureCookies;
  const sessionCookie = sessionCookieName(secure);
  const loginCookie = loginCookieName(secure);
  const consoleHome = new URL("/", settings.consoleOrigin).toString();
  const signInFailed = new URL("/?signin=failed", settings.consoleOrigin).toString();

  router.get("/login", async (_req, res) => {
    const log = requestLog(res, logger);
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
      serializeCookie(loginCookie, sealLoginTransaction(started.transaction, settings.sessionSecret), {
        path: LOGIN_COOKIE_PATH,
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
    res.append("Set-Cookie", clearCookie(loginCookie, { path: LOGIN_COOKIE_PATH, secure }));
    const sealed = parseCookies(req.get("cookie")).get(loginCookie);
    const transaction = sealed ? unsealLoginTransaction(sealed, settings.sessionSecret) : undefined;
    if (!transaction) {
      log.warn("sign-in callback without a valid login transaction");
      res.redirect(303, signInFailed);
      return;
    }
    try {
      // The IdP redirected the browser to the console origin, which forwards here.
      const callbackUrl = new URL(req.originalUrl, settings.consoleOrigin);
      const identity = await identityProvider.completeLogin(callbackUrl, transaction);
      const userId = await identityRepo.findOrCreateUser(db, identity);
      const session = await identityRepo.createSession(db, userId, settings.sessionTtlMs);
      res.append(
        "Set-Cookie",
        serializeCookie(sessionCookie, session.token, { path: "/", secure, maxAgeSeconds: settings.sessionTtlMs / 1000 }),
      );
      log.info({ userId, sessionId: session.sessionId }, "user signed in");
      res.redirect(303, consoleHome);
    } catch (err) {
      // Log the failure class only; never tokens, codes or claims.
      log.warn({ err }, "sign-in failed");
      res.redirect(303, signInFailed);
    }
  });

  router.post("/logout", requireSameOrigin(settings.consoleOrigin), async (req, res) => {
    const log = requestLog(res, logger);
    const token = parseCookies(req.get("cookie")).get(sessionCookie);
    const session = token ? await identityRepo.resolveSession(db, token) : undefined;
    if (session) {
      await identityRepo.revokeSession(db, session);
      log.info({ userId: session.userId, sessionId: session.sessionId }, "user signed out");
    }
    res.append("Set-Cookie", clearCookie(sessionCookie, { path: "/", secure }));
    res.set("Cache-Control", "no-store");
    res.redirect(303, consoleHome);
  });

  return router;
}
