"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { SSO_ERROR_MESSAGES } from "./workeasy360";

type Mode = "sign-in" | "sign-up";

interface Methods {
  password: boolean;
  sso: boolean;
  /** WorkEasy360 Accounts (docs/workeasy360-sso.md). */
  workeasy360?: boolean;
}

/**
 * Email and password sign-in and sign-up, plus "Continue with WorkEasy360"
 * and single sign-on when the server offers them. After success the browser
 * goes to `returnTo` (an invitation link) or the landing page. This page never
 * starts a WorkEasy360 sign-in by itself: the person chooses.
 */
export function SignIn({ signInFailed, returnTo, ssoError }: { signInFailed: boolean; returnTo?: string; ssoError?: string }) {
  const ids = { email: useId(), password: useId(), name: useId() };
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(
    ssoError ? (SSO_ERROR_MESSAGES[ssoError] ?? "Sign-in didn't complete. Please try again.") : signInFailed ? "Sign-in didn't complete. Please try again." : undefined,
  );
  const [methods, setMethods] = useState<Methods>({ password: true, sso: false });
  const { sso, workeasy360 } = methods;

  useEffect(() => {
    api<Methods>("/auth/methods")
      .then(setMethods)
      .catch(() => setMethods({ password: true, sso: false }));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body = mode === "sign-up" ? { email, password, ...(name.trim() ? { name } : {}) } : { email, password };
      await api(`/auth/password/${mode === "sign-up" ? "signup" : "login"}`, { method: "POST", body });
      window.location.assign(returnTo ?? "/");
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.");
      setBusy(false);
    }
  }

  function switchTo(next: Mode) {
    setMode(next);
    setError(undefined);
  }

  const signingUp = mode === "sign-up";
  const workeasy360Button = workeasy360 && (
    <a className="c-btn c-btn-primary" href="/auth/workeasy360/start">
      Continue with WorkEasy360
    </a>
  );
  if (!methods.password) {
    // WorkEasy360 is the only way in (WORKEASY360_SSO_ONLY).
    return (
      <div className="c-card" style={{ display: "grid", gap: 14 }}>
        <h2 style={{ margin: 0 }}>Sign in</h2>
        <p style={{ margin: 0, color: "var(--we-text-secondary)" }}>Sign in with your WorkEasy360 account.</p>
        {error && (
          <p role="alert" className="c-error" style={{ margin: 0 }}>
            {error}
          </p>
        )}
        {workeasy360Button}
      </div>
    );
  }
  return (
    <form className="c-card" style={{ display: "grid", gap: 14 }} onSubmit={submit} noValidate={false}>
      <h2 style={{ margin: 0 }}>{signingUp ? "Create your account" : "Sign in"}</h2>
      <p style={{ margin: 0, color: "var(--we-text-secondary)" }}>
        {signingUp ? "Build forms, share them and review responses." : "Welcome back. Sign in to your forms."}
      </p>
      {!signingUp && workeasy360Button}
      {!signingUp && workeasy360 && <p style={{ margin: 0, fontSize: 14, color: "var(--we-text-secondary)" }}>Or with your email and password:</p>}
      {signingUp && (
        <div className="c-field">
          <label className="c-label" htmlFor={ids.name}>
            Your name <span style={{ color: "var(--we-text-secondary)", fontWeight: 400 }}>(optional)</span>
          </label>
          <input id={ids.name} className="c-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="name" />
        </div>
      )}
      <div className="c-field">
        <label className="c-label" htmlFor={ids.email}>
          Email
        </label>
        <input id={ids.email} className="c-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" />
      </div>
      <div className="c-field">
        <label className="c-label" htmlFor={ids.password}>
          Password
        </label>
        <input
          id={ids.password}
          className="c-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={signingUp ? 10 : 1}
          maxLength={200}
          autoComplete={signingUp ? "new-password" : "current-password"}
          aria-describedby={signingUp ? `${ids.password}-hint` : undefined}
        />
        {signingUp && (
          <span id={`${ids.password}-hint`} style={{ fontSize: 13, color: "var(--we-text-secondary)" }}>
            At least 10 characters.
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="c-error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <button type="submit" className="c-btn c-btn-primary" disabled={busy || email === "" || password === ""}>
        {busy ? (signingUp ? "Creating account…" : "Signing in…") : signingUp ? "Create account" : "Sign in"}
      </button>
      <p style={{ margin: 0, fontSize: 14 }}>
        {signingUp ? "Already have an account? " : "New to Workeasy? "}
        <button type="button" className="c-link-btn" onClick={() => switchTo(signingUp ? "sign-in" : "sign-up")}>
          {signingUp ? "Sign in" : "Create an account"}
        </button>
      </p>
      {sso && (
        <p style={{ margin: 0, fontSize: 14 }}>
          <a href={`/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}>Sign in with single sign-on</a>
        </p>
      )}
    </form>
  );
}
