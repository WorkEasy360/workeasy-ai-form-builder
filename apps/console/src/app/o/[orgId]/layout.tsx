import type { ReactNode } from "react";
import { OrgShell } from "./org-shell";

export default async function OrgLayout({ params, children }: { params: Promise<{ orgId: string }>; children: ReactNode }) {
  const { orgId } = await params;
  return <OrgShell orgId={orgId}>{children}</OrgShell>;
}
