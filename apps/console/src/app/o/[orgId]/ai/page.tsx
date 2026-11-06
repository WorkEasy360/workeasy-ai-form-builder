import { Page } from "@workeasy/ui/react";
import { AiSettingsForm } from "./ai-settings";

export default async function AiSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <Page narrow>
      <AiSettingsForm orgId={orgId} />
    </Page>
  );
}
