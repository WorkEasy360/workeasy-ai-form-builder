import { JobList } from "./job-list";

export default async function JobsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <main className="c-page c-page-wide">
      <JobList orgId={orgId} />
    </main>
  );
}
