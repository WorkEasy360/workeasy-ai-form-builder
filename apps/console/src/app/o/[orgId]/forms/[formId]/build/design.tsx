"use client";

import { BuilderError, updateTheme } from "@workeasy/builder";
import { contrastRatio, DEFAULT_THEME, MIN_ACCENT_CONTRAST, MIN_TEXT_CONTRAST } from "@workeasy/form-engine";
import type { DefinitionIssue, FormDefinition, Theme } from "@workeasy/form-schema";
import { useId } from "react";
import { CommitInput, type TryApply } from "./controls";

type ColorKey = "accent" | "background" | "text";

const COLORS: Array<{ key: ColorKey; label: string; hint: string }> = [
  { key: "accent", label: "Accent colour", hint: "Buttons, selected choices and focus outlines." },
  { key: "background", label: "Background colour", hint: "Behind the whole form." },
  { key: "text", label: "Text colour", hint: "Questions, answers and help text." },
];

function applyTheme(definition: FormDefinition, patch: Partial<Theme>, tryApply: TryApply): string | undefined {
  try {
    return tryApply(updateTheme(definition, patch));
  } catch (err) {
    return err instanceof BuilderError ? err.message : "That theme change isn't possible.";
  }
}

/** One colour: a hex text box (typed, checked) plus the browser's colour picker. */
function ColorInput({ definition, colorKey, label, hint, tryApply }: { definition: FormDefinition; colorKey: ColorKey; label: string; hint: string; tryApply: TryApply }) {
  const pickerId = useId();
  const value = definition.theme[colorKey];
  return (
    <div className="b-color">
      <CommitInput
        label={label}
        hint={hint}
        value={value}
        onCommit={(text) => applyTheme(definition, { [colorKey]: text.trim() }, tryApply)}
      />
      <label htmlFor={pickerId} className="b-visually-hidden">
        Pick {label.toLowerCase()}
      </label>
      <input id={pickerId} type="color" className="b-swatch" value={value.toLowerCase()} onChange={(e) => applyTheme(definition, { [colorKey]: e.target.value }, tryApply)} />
    </div>
  );
}

function ContrastLine({ label, ratio, min }: { label: string; ratio: number; min: number }) {
  const passes = ratio >= min;
  return (
    <li style={passes ? undefined : { color: "var(--we-color-danger)" }}>
      {label}: {(Math.floor(ratio * 10) / 10).toFixed(1)}:1 — {passes ? "passes" : `needs ${min}:1`}
    </li>
  );
}

/** Theme tokens for the form (docs/03 §2): colours, contrast and corner rounding. */
export function DesignInspector({ definition, issues, tryApply }: { definition: FormDefinition; issues: DefinitionIssue[]; tryApply: TryApply }) {
  const { theme } = definition;
  const themeProblems = issues.filter((i) => i.path.startsWith("/theme"));
  const isDefault = (Object.keys(DEFAULT_THEME) as Array<keyof Theme>).every((k) => theme[k] === DEFAULT_THEME[k]);
  return (
    <section aria-labelledby="design-heading">
      <h2 id="design-heading">Design</h2>
      {COLORS.map((c) => (
        <ColorInput key={c.key} definition={definition} colorKey={c.key} label={c.label} hint={c.hint} tryApply={tryApply} />
      ))}
      <CommitInput
        label="Corner rounding (px)"
        type="number"
        min={0}
        max={24}
        value={String(theme.radius)}
        hint="0 for square corners, up to 24."
        onCommit={(text) => {
          const n = Number(text);
          return text.trim() === "" || !Number.isInteger(n) ? "Enter a whole number from 0 to 24." : applyTheme(definition, { radius: n }, tryApply);
        }}
      />
      <h3 style={{ fontSize: 14, margin: "8px 0 4px" }}>Contrast</h3>
      <ul className="b-issues" aria-live="polite">
        <ContrastLine label="Text on background" ratio={contrastRatio(theme.text, theme.background)} min={MIN_TEXT_CONTRAST} />
        <ContrastLine label="Accent on background" ratio={contrastRatio(theme.accent, theme.background)} min={MIN_ACCENT_CONTRAST} />
      </ul>
      {themeProblems.length > 0 && (
        <p className="b-inline-error" style={{ marginTop: 8 }}>
          Fix the contrast before publishing so everyone can read the form.
        </p>
      )}
      <p>
        <button type="button" className="b-btn" disabled={isDefault} onClick={() => applyTheme(definition, DEFAULT_THEME, tryApply)}>
          Reset to default theme
        </button>
      </p>
    </section>
  );
}
