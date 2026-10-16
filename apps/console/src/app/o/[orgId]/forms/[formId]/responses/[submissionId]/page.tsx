import { ResponseDetail } from "./response-detail";

export default async function ResponsePage({ params }: { params: Promise<{ orgId: string; formId: string; submissionId: string }> }) {
  const { orgId, formId, submissionId } = await params;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <ResponseDetail orgId={orgId} formId={formId} submissionId={submissionId} />
    </main>
  );
}
