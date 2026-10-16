import { AuditLog } from "./audit-log";

export default async function AuditPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <AuditLog orgId={orgId} />
    </main>
  );
}
