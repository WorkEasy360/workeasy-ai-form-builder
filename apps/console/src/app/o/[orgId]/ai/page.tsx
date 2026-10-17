import { AiSettingsForm } from "./ai-settings";

export default async function AiSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <main className="c-page">
      <AiSettingsForm orgId={orgId} />
    </main>
  );
}
