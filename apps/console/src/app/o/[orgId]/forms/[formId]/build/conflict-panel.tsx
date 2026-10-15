"use client";

import { diffDefinitions, type DefinitionChange } from "@workeasy/builder";
import type { FormDefinition } from "@workeasy/form-schema";
import type { DraftBody } from "./use-editor";

const VERBS: Record<DefinitionChange["kind"], string> = { added: "Added", removed: "Removed", changed: "Changed" };
const TARGETS: Record<Exclude<DefinitionChange["target"], "form">, string> = { page: "page", question: "question", rule: "rule" };

function describe(change: DefinitionChange): string {
  if (change.target === "form") return `Changed the form's ${change.details.join(", ")}`;
  const subject = `${TARGETS[change.target]} “${change.name}”`;
  return change.kind === "changed" ? `Changed ${subject}: ${change.details.join(", ")}` : `${VERBS[change.kind]} ${subject}`;
}

function ChangeList({ title, changes }: { title: string; changes: DefinitionChange[] }) {
  return (
    <div style={{ flex: "1 1 260px" }}>
      <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>{title}</h3>
      {changes.length === 0 ? (
        <p className="b-muted" style={{ margin: 0 }}>
          None
        </p>
      ) : (
        <ul className="b-issues">
          {changes.map((c) => (
            <li key={`${c.target}:${c.id}:${c.kind}`}>{describe(c)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function downloadJson(definition: FormDefinition, fileName: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Shown when someone else saved first. The local version is never thrown
 * away silently: it stays in this tab, can be downloaded, and remains in the
 * undo history even after choosing the other version. Both sides' changes
 * are listed against the last version this tab saved.
 */
export function ConflictPanel({
  formName,
  base,
  mine,
  theirs,
  onKeepMine,
  onUseTheirs,
}: {
  formName: string;
  base: FormDefinition | null;
  mine: FormDefinition;
  theirs: DraftBody | null;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}) {
  const who = theirs?.updatedBy.displayName ?? "Someone else";
  const when = theirs ? new Date(theirs.updatedAt).toLocaleString() : "";
  return (
    <section className="b-banner" data-kind="error" role="alert" aria-labelledby="conflict-heading">
      <h2 id="conflict-heading" style={{ fontSize: 16, margin: "0 0 4px" }}>
        This form was changed somewhere else
      </h2>
      {!theirs ? (
        <p style={{ margin: 0 }}>Your changes are safe in this tab and have not been saved. Loading the other version…</p>
      ) : (
        <>
          <p style={{ margin: "0 0 8px" }}>
            {who} saved a newer version at {when}. Your changes are safe in this tab and have not been saved yet.
          </p>
          {base && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 8 }}>
              <ChangeList title="Your unsaved changes" changes={diffDefinitions(base, mine)} />
              <ChangeList title={`Changes in ${who === "Someone else" ? "their" : `${who}'s`} version`} changes={diffDefinitions(base, theirs.definition)} />
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="b-btn b-primary" onClick={onKeepMine}>
              Keep my version (replace theirs)
            </button>
            <button type="button" className="b-btn" onClick={onUseTheirs}>
              Use their version (undo brings yours back)
            </button>
            <button type="button" className="b-btn" onClick={() => downloadJson(mine, `${formName} - my version.json`)}>
              Download my version
            </button>
          </div>
        </>
      )}
    </section>
  );
}
