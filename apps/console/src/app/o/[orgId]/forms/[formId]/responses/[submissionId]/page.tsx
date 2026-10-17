import { ResponseDetail } from "./response-detail";

export default async function ResponsePage({ params }: { params: Promise<{ orgId: string; formId: string; submissionId: string }> }) {
  const { orgId, formId, submissionId } = await params;
  return (
    <main className="c-page">
      <ResponseDetail orgId={orgId} formId={formId} submissionId={submissionId} />
    </main>
  );
}
