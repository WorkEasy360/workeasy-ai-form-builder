import { PreviewApp } from "./preview-app";

export default async function PreviewPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return <PreviewApp orgId={orgId} formId={formId} />;
}
