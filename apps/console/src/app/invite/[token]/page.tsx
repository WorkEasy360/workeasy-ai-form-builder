import { AcceptInvitation } from "./accept-invitation";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "var(--we-space-12) var(--we-space-4)", display: "grid", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="c-brand-mark" aria-hidden="true">
          W
        </span>
        <h1 style={{ margin: 0 }}>WorkEasy360 Forms</h1>
      </div>
      <AcceptInvitation token={token} />
    </main>
  );
}
