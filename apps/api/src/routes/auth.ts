import { Router, type Response } from "express";
import { z } from "zod";
import type { IdentityProvider } from "@workeasy/auth";
import { identityRepo, type Db } from "@workeasy/database";
import type { Logger } from "@workeasy/observability";
import type { AppDependencies } from "../app.js";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies.js";
import { sendProblem } from "../http/problem.js";
import { requestLog } from "../http/request-context.js";
import { requireSameOrigin } from "../http/same-origin.js";
import { LOGIN_TRANSACTION_MAX_AGE_MS, sealLoginTransaction, unsealLoginTransaction } from "../identity/login-transaction.js";
import {
  createAttemptLimiter,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  unknownAccountHash,
  verifyPassword,
} from "../identity/passwords.js";

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

/** Console pages a user may be sent back to after signing in: only invitation links. */
const INVITE_RETURN_PATH = /^\/invite\/[A-Za-z0-9_-]{20,200}$/;

const Email = z.email().trim().toLowerCase().max(254);
const SignUpBodySchema = z.object({
  email: Email,
  password: z.string().min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`).max(PASSWORD_MAX_LENGTH),
  name: z.string().trim().min(1).max(200).optional(),
});
const SignInBodySchema = z.object({ email: Email, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

/** Failed sign-ins allowed per email before a 15-minute pause. */
const MAX_FAILED_SIGN_INS = 10;
/** New accounts per hour from this server; a ceiling on scripted sign-ups. */
const MAX_SIGN_UPS_PER_HOUR = 200;

/**
 * Email and password accounts at /auth/password (sign-up and sign-in), next
 * to OIDC. A success opens the same server-side session as OIDC sign-in.
 */
function passwordRouter({ db, settings, logger }: AppDependencies, secure: boolean): Router {
  const router = Router();
  const sessionCookie = sessionCookieName(secure);
  const failures = createAttemptLimiter(MAX_FAILED_SIGN_INS, 15 * 60 * 1000);
  const signUps = createAttemptLimiter(MAX_SIGN_UPS_PER_HOUR, 60 * 60 * 1000);
  router.use(requireSameOrigin(settings.consoleOrigin));

  async function openSession(res: Response, userId: string) {
    const session = await identityRepo.createSession(db, userId, settings.sessionTtlMs);
    res.append("Set-Cookie", serializeCookie(sessionCookie, session.token, { path: "/", secure, maxAgeSeconds: settings.sessionTtlMs / 1000 }));
    res.set("Cache-Control", "no-store");
    res.json({ ok: true });
    return session;
  }

  function invalid(res: Response, error: z.ZodError) {
    const errors = error.issues.map((i) => ({ field: i.path.map(String).join(".") || "body", code: i.code.toUpperCase(), message: i.message }));
    sendProblem(res, 422, "VALIDATION_FAILED", errors[0]?.message ?? "Check the details and try again", { errors });
  }

  router.post("/signup", async (req, res) => {
    const log = requestLog(res, logger);
    const body = SignUpBodySchema.safeParse(req.body);
    if (!body.success) {
      invalid(res, body.error);
      return;
    }
    if (signUps.blocked("all")) {
      sendProblem(res, 429, "TOO_MANY_SIGN_UPS", "Too many new accounts right now. Try again later");
      return;
    }
    const { email, password, name } = body.data;
    const userId = await identityRepo.createPasswordAccount(db, {
      email,
      passwordHash: await hashPassword(password),
      displayName: name ?? email,
    });
    if (!userId) {
      sendProblem(res, 409, "EMAIL_TAKEN", "An account with this email already exists. Sign in instead");
      return;
    }
    signUps.fail("all");
    const session = await openSession(res, userId);
    log.info({ userId, sessionId: session.sessionId }, "user signed up with a password");
  });

  router.post("/login", async (req, res) => {
    const log = requestLog(res, logger);
    const body = SignInBodySchema.safeParse(req.body);
    if (!body.success) {
      invalid(res, body.error);
      return;
    }
    const { email, password } = body.data;
    if (failures.blocked(email)) {
      sendProblem(res, 429, "TOO_MANY_ATTEMPTS", "Too many failed attempts. Wait 15 minutes and try again");
      return;
    }
    const credential = await identityRepo.findPasswordCredential(db, email);
    // Unknown emails cost the same time as wrong passwords.
    const ok = await verifyPassword(password, credential?.passwordHash ?? (await unknownAccountHash()));
    if (!credential || !ok) {
      failures.fail(email);
      log.info("password sign-in failed");
      sendProblem(res, 401, "INVALID_CREDENTIALS", "That email and password don't match an account");
      return;
    }
    failures.reset(email);
    const session = await openSession(res, credential.userId);
    log.info({ userId: credential.userId, sessionId: session.sessionId }, "user signed in with a password");
  });

  return router;
}

/** Console sign-in at /auth on the console origin. */
export function authRouter(deps: AppDependencies): Router {
  const { db, identityProvider, settings, logger } = deps;
  const secure = settings.secureCookies;
  const router = Router();
  router.use("/password", passwordRouter(deps, secure));
  // Which sign-in options the console offers: email and password always, single sign-on when its provider answers.
  router.get("/methods", async (_req, res) => {
    const sso = identityProvider.isAvailable ? await identityProvider.isAvailable() : true;
    res.set("Cache-Control", "no-store");
    res.json({ password: true, sso });
  });
  return router.use(signInRouter({
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
    home: (returnTo) => new URL(returnTo ?? "/", settings.consoleOrigin).toString(),
    signInFailed: () => new URL("/?signin=failed", settings.consoleOrigin).toString(),
    parseReturnTo: (raw) => (typeof raw === "string" && INVITE_RETURN_PATH.test(raw) ? raw : undefined),
  }));
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
