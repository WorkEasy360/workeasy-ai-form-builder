import { AiSettingsForm } from "./ai-settings";

export default async function AiSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <AiSettingsForm orgId={orgId} />
    </main>
  );
}
