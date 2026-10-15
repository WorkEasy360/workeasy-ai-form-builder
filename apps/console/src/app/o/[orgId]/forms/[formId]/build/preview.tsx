"use client";

import { validateDraft } from "@workeasy/form-engine";
import { FormRenderer } from "@workeasy/form-renderer";
import type { DefinitionIssue, FormDefinition } from "@workeasy/form-schema";
import { useId, useMemo, useState } from "react";

type Device = "desktop" | "mobile";

const DEVICES: Array<{ id: Device; label: string; width: number | undefined }> = [
  { id: "desktop", label: "Desktop", width: undefined },
  { id: "mobile", label: "Mobile (375 px)", width: 375 },
];

/**
 * Problems that stop the engine from running the draft at all: broken page
 * lists, duplicate IDs and invalid rules (a backward skip would never end).
 * Everything else, such as low theme contrast, still previews.
 */
export function previewBlockers(issues: readonly DefinitionIssue[]): DefinitionIssue[] {
  return issues.filter((i) => i.path.startsWith("/rules") || i.path.startsWith("/pages") || i.code === "DUPLICATE_ID");
}

/**
 * The draft as respondents will see it, rendered by the shared runtime with
 * the same engine the server uses. Nothing is submitted: the last step shows
 * the success message.
 */
export function PreviewPane({ definition, openHref }: { definition: FormDefinition; openHref?: string | undefined }) {
  const name = useId();
  const [device, setDevice] = useState<Device>("desktop");
  const [run, setRun] = useState(0);
  const blockers = useMemo(() => previewBlockers(validateDraft(definition).issues), [definition]);
  const width = DEVICES.find((d) => d.id === device)?.width;

  return (
    <section className="b-preview" aria-labelledby={`${name}-heading`}>
      <div className="b-preview-bar">
        <h2 id={`${name}-heading`} style={{ fontSize: 16, margin: 0 }}>
          Preview
        </h2>
        <fieldset className="b-segmented">
          <legend className="b-visually-hidden">Preview size</legend>
          {DEVICES.map((d) => (
            <label key={d.id}>
              <input type="radio" name={`${name}-device`} value={d.id} checked={device === d.id} onChange={() => setDevice(d.id)} /> {d.label}
            </label>
          ))}
        </fieldset>
        <button type="button" className="b-btn" onClick={() => setRun((n) => n + 1)}>
          Restart
        </button>
        {openHref && (
          <a href={openHref} target="_blank" rel="noopener">
            Open in new tab
          </a>
        )}
      </div>
      <p className="b-muted" style={{ margin: "0 0 12px" }}>
        Answers in a preview aren&apos;t saved or sent anywhere.
      </p>
      {blockers.length > 0 ? (
        <div role="alert" className="b-banner" data-kind="error">
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Fix these before previewing:</p>
          <ul className="b-issues">
            {blockers.map((i) => (
              <li key={`${i.path}:${i.code}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="b-device" data-device={device} style={width ? { width } : undefined}>
          <FormRenderer key={run} definition={definition} idPrefix="preview" titleLevel={2} restartLabel="Start again" onSubmit={() => undefined} />
        </div>
      )}
    </section>
  );
}
