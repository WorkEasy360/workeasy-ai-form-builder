import { FormAnalytics } from "./form-analytics";

export default async function AnalyticsPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <FormAnalytics orgId={orgId} formId={formId} />
    </main>
  );
}
