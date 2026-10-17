import { ResponsesApp } from "./responses-app";

export default async function ResponsesPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <main className="c-page c-page-wide">
      <ResponsesApp orgId={orgId} formId={formId} />
    </main>
  );
}
