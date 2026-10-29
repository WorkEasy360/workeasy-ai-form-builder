import { SessionPanel } from "./session-panel";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { signin, returnTo } = await searchParams;
  // Only invitation links may be returned to after signing in.
  const safeReturnTo = typeof returnTo === "string" && /^\/invite\/[A-Za-z0-9_-]{20,200}$/.test(returnTo) ? returnTo : undefined;
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "var(--we-space-12) var(--we-space-4)", display: "grid", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="c-brand-mark" aria-hidden="true" style={{ width: 40, height: 40, fontSize: 18, borderRadius: 10 }}>
          W
        </span>
        <div>
          <h1 style={{ margin: 0 }}>WorkEasy360 Forms</h1>
          <p className="c-hint" style={{ margin: 0 }}>
            AI form builder
          </p>
        </div>
      </div>
      <SessionPanel signInFailed={signin === "failed"} {...(safeReturnTo ? { returnTo: safeReturnTo } : {})} />
    </main>
  );
}
