import { Page } from "@workeasy/ui/react";
import { MembersPanel } from "./members-panel";

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <Page narrow>
      <MembersPanel orgId={orgId} />
    </Page>
  );
}
