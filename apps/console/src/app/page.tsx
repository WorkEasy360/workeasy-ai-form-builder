import { AuthFrame } from "./auth-frame";
import { SessionPanel } from "./session-panel";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { signin, returnTo, sso_error: ssoError, reason } = await searchParams;
  // Only invitation links may be returned to after signing in.
  const safeReturnTo = typeof returnTo === "string" && /^\/invite\/[A-Za-z0-9_-]{20,200}$/.test(returnTo) ? returnTo : undefined;
  return (
    <AuthFrame>
      <SessionPanel
        signInFailed={signin === "failed"}
        {...(safeReturnTo ? { returnTo: safeReturnTo } : {})}
        {...(typeof ssoError === "string" && /^[a-z_]{1,40}$/.test(ssoError) ? { ssoError } : {})}
        {...(typeof reason === "string" && /^[a-z_]{1,40}$/.test(reason) ? { reason } : {})}
      />
    </AuthFrame>
  );
}
