import { BuilderApp } from "./builder-app";

export default async function BuildPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return <BuilderApp orgId={orgId} formId={formId} />;
}
