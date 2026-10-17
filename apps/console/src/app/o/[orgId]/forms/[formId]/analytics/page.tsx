import { FormAnalytics } from "./form-analytics";

export default async function AnalyticsPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <main className="c-page">
      <FormAnalytics orgId={orgId} formId={formId} />
    </main>
  );
}
