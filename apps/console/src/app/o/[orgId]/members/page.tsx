import { MembersPanel } from "./members-panel";

export default async function MembersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <div className="c-page">
      <MembersPanel orgId={orgId} />
    </div>
  );
}
