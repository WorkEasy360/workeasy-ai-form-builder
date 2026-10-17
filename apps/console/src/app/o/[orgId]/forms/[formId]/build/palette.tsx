"use client";

import { FIELD_TYPE_INFO, PALETTE_GROUPS } from "@workeasy/builder";
import type { FieldType } from "@workeasy/form-schema";
import { useId, useState } from "react";

/** What is being dragged out of the palette; read back on drop. */
export const DRAG_NEW_FIELD = "application/x-workeasy-new-field";
export const DRAG_PAGE_BREAK = "application/x-workeasy-page-break";
export const DRAG_FIELD = "application/x-workeasy-field";

/** A short visual cue per field type, shown in the palette tile. */
const GLYPHS: Record<FieldType, string> = {
  text: "Aa",
  textarea: "¶",
  email: "@",
  phone: "☏",
  url: "↗",
  integer: "123",
  decimal: "1.5",
  rating: "☆",
  date: "31",
  time: "◷",
  dropdown: "▾",
  radio: "◉",
  multi_select: "☰",
  checkbox: "☑",
  consent: "✓",
  file: "⇪",
};

/**
 * The field palette: every field type as a tile, grouped and searchable.
 * Drag a tile onto the form to place it exactly, or click it to add it after
 * the selected question. "Page break" starts a new page.
 */
export function Palette({
  disabled,
  full,
  addTargetText,
  onAdd,
  onAddPage,
  onDragStart,
  onDragEnd,
}: {
  disabled: boolean;
  /** At the field limit: nothing more can be added. */
  full: boolean;
  /** Where a click adds, e.g. "after Email on page 1". */
  addTargetText: string;
  onAdd: (type: FieldType) => void;
  onAddPage: () => void;
  onDragStart: (item: { kind: "new"; type: FieldType } | { kind: "page-break" }) => void;
  onDragEnd: () => void;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (type: FieldType) => !q || FIELD_TYPE_INFO[type].label.toLowerCase().includes(q) || FIELD_TYPE_INFO[type].description.toLowerCase().includes(q);
  const groups = PALETTE_GROUPS.map((g) => ({ ...g, types: g.types.filter(matches) })).filter((g) => g.types.length > 0);
  const showBreak = !q || "page break new page".includes(q);

  return (
    <div className="b-palette-panel">
      <h2 style={{ marginBottom: 4 }}>Fields</h2>
      <p className="b-muted" style={{ margin: "0 0 8px" }}>
        Drag onto the form, or click to add {addTargetText}.
      </p>
      <label htmlFor={searchId} className="b-visually-hidden">
        Search fields
      </label>
      <input id={searchId} className="b-search" type="search" placeholder="Search fields" value={query} onChange={(e) => setQuery(e.target.value)} />
      {groups.map(({ group, types }) => (
        <div key={group} role="group" aria-label={group} className="b-tile-group">
          <h3 className="b-tile-heading">{group}</h3>
          <div className="b-tiles">
            {types.map((type) => (
              <button
                key={type}
                type="button"
                className="b-tile"
                draggable={!disabled && !full}
                disabled={disabled || full}
                title={FIELD_TYPE_INFO[type].description}
                aria-label={`Add ${FIELD_TYPE_INFO[type].label}: ${FIELD_TYPE_INFO[type].description}`}
                onClick={() => onAdd(type)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_NEW_FIELD, type);
                  e.dataTransfer.effectAllowed = "copy";
                  onDragStart({ kind: "new", type });
                }}
                onDragEnd={onDragEnd}
              >
                <span className="b-glyph" aria-hidden="true">
                  {GLYPHS[type]}
                </span>
                <span>{FIELD_TYPE_INFO[type].label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {showBreak && (
        <div role="group" aria-label="Layout" className="b-tile-group">
          <h3 className="b-tile-heading">Layout</h3>
          <div className="b-tiles">
            <button
              type="button"
              className="b-tile"
              draggable={!disabled}
              disabled={disabled}
              title="Start a new page here"
              aria-label="Add page break: start a new page"
              onClick={onAddPage}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_PAGE_BREAK, "1");
                e.dataTransfer.effectAllowed = "copy";
                onDragStart({ kind: "page-break" });
              }}
              onDragEnd={onDragEnd}
            >
              <span className="b-glyph" aria-hidden="true">
                ⤓
              </span>
              <span>Page break</span>
            </button>
          </div>
        </div>
      )}
      {groups.length === 0 && !showBreak && <p className="b-muted">No fields match “{query}”.</p>}
    </div>
  );
}
