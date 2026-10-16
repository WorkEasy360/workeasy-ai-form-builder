"use client";

import {
  addOption,
  FIELD_TYPE_INFO,
  fieldRuleOf,
  moveFieldToPage,
  moveOption,
  removeOption,
  renameOption,
  renamePage,
  updateField,
  updateFieldSettings,
  updateFormDetails,
  type SettingsInput,
} from "@workeasy/builder";
import { FIELD_REGISTRY } from "@workeasy/form-engine";
import type { DefinitionIssue, Field, FieldSettings, FormDefinition, PrivacyClass } from "@workeasy/form-schema";

const PRIVACY_LABELS: Record<PrivacyClass, string> = { ordinary: "Ordinary", personal: "Personal data", sensitive: "Sensitive data" };
import { CommitInput, type TryApply } from "./controls";
import { FieldLogic, PageLogic } from "./logic-editor";

export { CommitInput, type TryApply } from "./controls";

function IssueList({ issues }: { issues: DefinitionIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div role="group" aria-label="Problems to fix before publishing">
      <h3 style={{ fontSize: 14, margin: "8px 0 4px" }}>To fix before publishing</h3>
      <ul className="b-issues">
        {issues.map((i) => (
          <li key={`${i.path}:${i.code}`}>{i.message}</li>
        ))}
      </ul>
    </div>
  );
}

// Form ------------------------------------------------------------------------

export function FormInspector({ definition, tryApply }: { definition: FormDefinition; tryApply: TryApply }) {
  return (
    <section aria-labelledby="inspector-heading">
      <h2 id="inspector-heading">Form details</h2>
      <CommitInput
        label="Title shown to respondents"
        value={definition.title}
        onCommit={(t) => (t.trim() === "" ? "The form needs a title." : tryApply(updateFormDetails(definition, { title: t })))}
      />
      <CommitInput
        label="Description"
        multiline
        value={definition.description ?? ""}
        onCommit={(t) => tryApply(updateFormDetails(definition, { description: t }))}
      />
      <CommitInput
        label="Message after submitting"
        multiline
        value={definition.success.message}
        onCommit={(t) => (t.trim() === "" ? "Add a message for respondents." : tryApply(updateFormDetails(definition, { successMessage: t })))}
      />
      <p className="b-muted">Select a question or page to edit it.</p>
    </section>
  );
}

// Page ------------------------------------------------------------------------

export function PageInspector({ definition, pageId, tryApply }: { definition: FormDefinition; pageId: string; tryApply: TryApply }) {
  const page = definition.pages.find((p) => p.id === pageId);
  if (!page) return null;
  return (
    <section aria-labelledby="inspector-heading">
      <h2 id="inspector-heading">Page</h2>
      <CommitInput
        key={page.id}
        label="Page title"
        value={page.title}
        hint="Shown above the page's questions. Optional."
        onCommit={(t) => tryApply(renamePage(definition, page.id, t))}
      />
      <p className="b-muted">
        {page.fieldIds.length === 1 ? "1 question" : `${page.fieldIds.length} questions`} on this page.
      </p>
      <PageLogic definition={definition} pageId={page.id} tryApply={tryApply} />
    </section>
  );
}

// Field -----------------------------------------------------------------------

const FILE_TYPES: Array<{ mime: string; label: string }> = [
  { mime: "application/pdf", label: "PDF" },
  { mime: "image/png", label: "PNG image" },
  { mime: "image/jpeg", label: "JPEG image" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document" },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel spreadsheet" },
  { mime: "text/plain", label: "Plain text" },
];

const MIB = 1024 * 1024;

function parseWhole(text: string): { value?: number; error?: string } {
  if (text.trim() === "") return {};
  const n = Number(text);
  return Number.isSafeInteger(n) ? { value: n } : { error: "Enter a whole number." };
}

export function FieldInspector({
  definition,
  fieldId,
  issues,
  tryApply,
}: {
  definition: FormDefinition;
  fieldId: string;
  issues: DefinitionIssue[];
  tryApply: TryApply;
}) {
  const index = definition.fields.findIndex((f) => f.id === fieldId);
  const field = definition.fields[index];
  if (!field) return null;
  const settings = field.settings;
  const page = definition.pages.find((p) => p.fieldIds.includes(field.id));
  const requiredByRule = fieldRuleOf(definition, field.id, "required") !== undefined;
  const fieldIssues = issues.filter((i) => i.path === `/fields/${index}` || i.path.startsWith(`/fields/${index}/`));

  const setSettings = (patch: SettingsInput) => tryApply(updateFieldSettings(definition, field.id, { ...settings, ...patch }));

  /** A whole-number setting; empty clears it. */
  const wholeSetting = (key: keyof FieldSettings, label: string, hint?: string, min?: number, max?: number) => (
    <CommitInput
      key={`${field.id}-${key}`}
      label={label}
      type="number"
      min={min}
      max={max}
      hint={hint}
      value={settings[key] === undefined ? "" : String(settings[key])}
      onCommit={(t) => {
        const parsed = parseWhole(t);
        if (parsed.error) return parsed.error;
        if (parsed.value !== undefined && ((min !== undefined && parsed.value < min) || (max !== undefined && parsed.value > max))) {
          return `Enter a number from ${min ?? "…"} to ${max ?? "…"}.`;
        }
        return setSettings({ [key]: parsed.value });
      }}
    />
  );

  /** A text-valued bound (decimal, date, time); empty clears it. */
  const textBound = (key: "min" | "max", label: string, type: "text" | "date" | "time" = "text") => (
    <CommitInput
      key={`${field.id}-${key}`}
      label={label}
      type={type}
      value={settings[key] === undefined ? "" : String(settings[key])}
      onCommit={(t) => setSettings({ [key]: t.trim() === "" ? undefined : t.trim() })}
    />
  );

  const isText = ["text", "textarea", "email", "phone", "url"].includes(field.type);
  const isChoice = ["dropdown", "radio", "multi_select"].includes(field.type);

  return (
    <section aria-labelledby="inspector-heading">
      <h2 id="inspector-heading">Question</h2>
      <p className="b-muted" style={{ marginTop: 0 }}>
        {FIELD_TYPE_INFO[field.type].label}
      </p>

      <CommitInput
        key={`${field.id}-label`}
        label="Question"
        value={field.label}
        onCommit={(t) => (t.trim() === "" ? "A question needs a label." : tryApply(updateField(definition, field.id, { label: t })))}
      />
      <CommitInput
        key={`${field.id}-help`}
        label="Help text"
        multiline
        value={field.helpText ?? ""}
        onCommit={(t) => tryApply(updateField(definition, field.id, { helpText: t }))}
      />
      <div className="b-field">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={field.required}
            disabled={requiredByRule}
            aria-describedby={requiredByRule ? `${field.id}-required-rule` : undefined}
            onChange={(e) => tryApply(updateField(definition, field.id, { required: e.target.checked }))}
          />
          {field.type === "consent" ? "Respondents must agree to submit" : "Required"}
        </label>
        {requiredByRule && (
          <p id={`${field.id}-required-rule`} className="b-muted" style={{ margin: 0 }}>
            Decided by the rule under Logic.
          </p>
        )}
      </div>

      <div className="b-field">
        <label htmlFor={`${field.id}-privacy`}>Data classification</label>
        <select
          id={`${field.id}-privacy`}
          value={field.privacy ?? "default"}
          aria-describedby={`${field.id}-privacy-hint`}
          onChange={(e) => tryApply(updateField(definition, field.id, { privacy: e.target.value === "default" ? null : (e.target.value as PrivacyClass) }))}
        >
          <option value="default">Default for this type ({PRIVACY_LABELS[FIELD_REGISTRY[field.type].privacy].toLowerCase()})</option>
          {(Object.keys(PRIVACY_LABELS) as PrivacyClass[]).map((c) => (
            <option key={c} value={c}>
              {PRIVACY_LABELS[c]}
            </option>
          ))}
        </select>
        <p id={`${field.id}-privacy-hint`} className="b-muted" style={{ margin: 0 }}>
          Reviewers need permission to see personal or sensitive answers; otherwise they are hidden.
        </p>
      </div>

      {definition.pages.length > 1 && page && (
        <div className="b-field">
          <label htmlFor={`${field.id}-page`}>Page</label>
          <select
            id={`${field.id}-page`}
            value={page.id}
            onChange={(e) => tryApply(moveFieldToPage(definition, field.id, e.target.value))}
          >
            {definition.pages.map((p, i) => (
              <option key={p.id} value={p.id}>
                {p.title || `Page ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {(isText || field.type === "integer" || field.type === "decimal") && (
        <CommitInput
          key={`${field.id}-placeholder`}
          label="Placeholder"
          value={settings.placeholder ?? ""}
          hint="Example text inside the empty box. Not a replacement for the label."
          onCommit={(t) => setSettings({ placeholder: t === "" ? undefined : t })}
        />
      )}
      {isText && (
        <>
          {wholeSetting("minLength", "Minimum characters", undefined, 0, 20000)}
          {wholeSetting("maxLength", "Maximum characters", undefined, 1, 20000)}
        </>
      )}
      {field.type === "integer" && (
        <>
          {wholeSetting("min", "Smallest allowed number")}
          {wholeSetting("max", "Largest allowed number")}
        </>
      )}
      {field.type === "rating" && (
        <>
          {wholeSetting("min", "Lowest rating", undefined, 0, 10)}
          {wholeSetting("max", "Highest rating", undefined, 0, 10)}
        </>
      )}
      {field.type === "decimal" && (
        <>
          {textBound("min", "Smallest allowed value")}
          {textBound("max", "Largest allowed value")}
        </>
      )}
      {field.type === "date" && (
        <>
          {textBound("min", "Earliest date", "date")}
          {textBound("max", "Latest date", "date")}
        </>
      )}
      {field.type === "time" && (
        <>
          {textBound("min", "Earliest time", "time")}
          {textBound("max", "Latest time", "time")}
        </>
      )}

      {isChoice && <OptionsEditor definition={definition} field={field} tryApply={tryApply} />}
      {field.type === "multi_select" && (
        <>
          {wholeSetting("minSelections", "Minimum choices", undefined, 0, 100)}
          {wholeSetting("maxSelections", "Maximum choices", undefined, 1, 100)}
        </>
      )}

      {field.type === "file" && (
        <>
          <fieldset className="b-field" style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
            <legend>Accepted file types</legend>
            {FILE_TYPES.map((t) => {
              const allowed = settings.allowedMimeTypes ?? [];
              return (
                <label key={t.mime} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={allowed.includes(t.mime)}
                    disabled={allowed.length === 1 && allowed.includes(t.mime)}
                    onChange={(e) =>
                      setSettings({
                        allowedMimeTypes: e.target.checked ? [...allowed, t.mime] : allowed.filter((m) => m !== t.mime),
                      })
                    }
                  />
                  {t.label}
                </label>
              );
            })}
          </fieldset>
          <CommitInput
            key={`${field.id}-size`}
            label="Largest file (MB)"
            type="number"
            min={1}
            max={10}
            value={settings.maxFileBytes === undefined ? "" : String(Math.round(settings.maxFileBytes / MIB))}
            onCommit={(t) => {
              const parsed = parseWhole(t);
              if (parsed.error || parsed.value === undefined || parsed.value < 1 || parsed.value > 10) return "Enter a size from 1 to 10 MB.";
              return setSettings({ maxFileBytes: parsed.value * MIB });
            }}
          />
          {wholeSetting("maxFiles", "Most files per answer", undefined, 1, 5)}
        </>
      )}

      {field.type === "consent" && (
        <CommitInput
          key={`${field.id}-consent`}
          label="Consent text version"
          hint="Recorded with each response. Change it whenever you change the wording."
          value={settings.consentTextVersion ?? ""}
          onCommit={(t) => (t.trim() === "" ? "Give this wording a version." : setSettings({ consentTextVersion: t.trim() }))}
        />
      )}

      <FieldLogic definition={definition} field={field} tryApply={tryApply} />

      <IssueList issues={fieldIssues} />
    </section>
  );
}

function OptionsEditor({ definition, field, tryApply }: { definition: FormDefinition; field: Field; tryApply: TryApply }) {
  const options = field.settings.options ?? [];
  return (
    <fieldset className="b-field" style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
      <legend>Options</legend>
      <ol className="b-list" style={{ listStyle: "decimal", paddingLeft: 20 }}>
        {options.map((o, i) => (
          <li key={o.id}>
            <CommitInput
              label={`Option ${i + 1}`}
              value={o.label}
              onCommit={(t) => (t.trim() === "" ? "An option needs a label." : tryApply(renameOption(definition, field.id, o.id, t)))}
            />
            <div className="b-row" style={{ marginTop: -8, marginBottom: 8 }}>
              <button type="button" className="b-btn" disabled={i === 0} onClick={() => tryApply(moveOption(definition, field.id, o.id, -1))} aria-label={`Move ${o.label} up`}>
                ↑
              </button>
              <button
                type="button"
                className="b-btn"
                disabled={i === options.length - 1}
                onClick={() => tryApply(moveOption(definition, field.id, o.id, 1))}
                aria-label={`Move ${o.label} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="b-btn"
                disabled={options.length <= 1}
                onClick={() => tryApply(removeOption(definition, field.id, o.id))}
                aria-label={`Remove ${o.label}`}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" className="b-btn" disabled={options.length >= 100} onClick={() => tryApply(addOption(definition, field.id).definition)}>
        Add option
      </button>
    </fieldset>
  );
}
