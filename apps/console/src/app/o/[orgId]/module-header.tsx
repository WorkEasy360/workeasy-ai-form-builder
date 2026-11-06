import type { ReactNode } from "react";
import { PageHeader } from "@workeasy/ui/react";
import { moduleByKey, type ModuleKey } from "../../../lib/modules";

/** A module page's header, from its entry in lib/modules.tsx: group, name and summary, with the primary action last. */
export function ModuleHeader({ module, actions }: { module: ModuleKey; actions?: ReactNode }) {
  const m = moduleByKey(module);
  return (
    <PageHeader
      eyebrow={
        <>
          {m.icon(14)}
          {m.group}
        </>
      }
      title={m.label}
      subtitle={m.summary}
      actions={actions}
    />
  );
}
