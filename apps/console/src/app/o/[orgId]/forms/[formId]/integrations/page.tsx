import { IntegrationsPanel } from "./integrations-panel";

export default async function IntegrationsPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <IntegrationsPanel orgId={orgId} formId={formId} />
    </main>
  );
}
