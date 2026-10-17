import { SettingsApp } from "./settings-app";

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string; formId: string }> }) {
  const { orgId, formId } = await params;
  return (
    <main className="c-page c-page-wide">
      <SettingsApp orgId={orgId} formId={formId} />
    </main>
  );
}
