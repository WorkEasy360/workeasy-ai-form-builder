import { FormsPanel } from "./forms-panel";

export default async function FormsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return <FormsPanel orgId={orgId} />;
}
