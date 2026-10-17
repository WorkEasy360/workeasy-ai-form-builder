"use client";

import type { FormDefinition } from "@workeasy/form-schema";
import { useId, useState } from "react";

/** Applies a candidate definition; returns an error message if it would make the draft unsaveable. */
export type TryApply = (next: FormDefinition) => string | undefined;

interface CommitInputProps {
  label: string;
  value: string;
  /** Returns an error message to keep the typed text and show the problem, or undefined when applied. */
  onCommit: (text: string) => string | undefined;
  multiline?: boolean;
  type?: "text" | "number" | "date" | "time" | "datetime-local";
  hint?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
}

/**
 * An input that keeps what the user typed even when it cannot be applied yet
 * (e.g. an empty label), showing why, instead of snapping back.
 */
export function CommitInput({ label, value, onCommit, multiline, type = "text", hint, min, max }: CommitInputProps) {
  const id = useId();
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [error, setError] = useState<string | undefined>();
  // Follow outside changes (another control, reload) unless the user is mid-fix.
  if (value !== seen) {
    setSeen(value);
    if (!error) setText(value);
  }
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value: text,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      setError(onCommit(e.target.value));
    },
  };
  return (
    <div className="b-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} type={type} min={min} max={max} />}
      {hint && (
        <p id={`${id}-hint`} className="b-muted" style={{ margin: 0 }}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="b-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
