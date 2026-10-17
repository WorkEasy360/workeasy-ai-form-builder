import { FormAnalytics } from "./form-analytics";

export default async function AnalyticsPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <div className="c-page">
      <FormAnalytics orgId={orgId} formId={formId} />
    </div>
  );
}
