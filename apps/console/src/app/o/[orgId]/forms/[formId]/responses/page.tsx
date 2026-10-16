import { ResponsesApp } from "./responses-app";

export default async function ResponsesPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <ResponsesApp orgId={orgId} formId={formId} />
    </main>
  );
}
