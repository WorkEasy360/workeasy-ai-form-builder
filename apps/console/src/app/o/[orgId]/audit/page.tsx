import { AuditLog } from "./audit-log";

export default async function AuditPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return (
    <div className="c-page c-page-wide">
      <AuditLog orgId={orgId} />
    </div>
  );
}
