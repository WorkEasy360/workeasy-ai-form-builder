import { IntegrationsPanel } from "./integrations-panel";

export default async function IntegrationsPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <div className="c-page">
      <IntegrationsPanel orgId={orgId} formId={formId} />
    </div>
  );
}
