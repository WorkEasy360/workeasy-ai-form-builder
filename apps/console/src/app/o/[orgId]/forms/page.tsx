import { FormsPanel } from "./forms-panel";

export default async function FormsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "var(--we-space-4) var(--we-space-2)" }}>
      <FormsPanel orgId={orgId} />
    </main>
  );
}
