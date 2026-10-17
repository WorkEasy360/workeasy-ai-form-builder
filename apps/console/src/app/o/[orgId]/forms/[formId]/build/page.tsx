import { BuilderApp } from "./builder-app";

export default async function BuildPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; formId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, formId } = await params;
  const { ai } = await searchParams;
  // ?ai=<generation> comes from "Describe it with AI" on the create page.
  const aiJob = typeof ai === "string" && /^[0-9a-f-]{36}$/i.test(ai) ? ai : undefined;
  return <BuilderApp orgId={orgId} formId={formId} {...(aiJob ? { aiJob } : {})} />;
}
