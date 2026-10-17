import type { ReactNode } from "react";
import { FormFrame } from "./form-frame";

export default async function FormLayout({ params, children }: { params: Promise<{ orgId: string; formId: string }>; children: ReactNode }) {
  const { orgId, formId } = await params;
  return (
    <FormFrame orgId={orgId} formId={formId}>
      {children}
    </FormFrame>
  );
}
