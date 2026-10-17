/**
 * Builder layout (docs/01 §3): a quiet toolbar, the field list on the left,
 * the form as a sheet on a grey workspace in the middle, and properties on
 * the right; stacked on narrow screens. Questions show their tools only on
 * hover, focus or selection, so the form itself stays readable.
 */
export const BUILDER_CSS = `
.b-shell { display: grid; grid-template-rows: auto 1fr; background: var(--we-color-surface); min-height: calc(100vh - 152px); }

/* Toolbar */
.b-topbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--we-color-border); background: var(--we-color-background);
  position: sticky; top: var(--c-topbar, 0); z-index: 10; }
.b-bar-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.b-icon-btn { width: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--we-color-text); cursor: pointer; }
.b-icon-btn:hover:not(:disabled) { background: var(--we-color-surface); border-color: var(--we-color-border); }
.b-icon-btn:disabled { color: var(--we-color-textMuted); opacity: .45; cursor: not-allowed; }
.b-save { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; font-size: 13px; color: var(--we-color-textMuted); }
.b-save::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--we-color-success, #166534); }
.b-save[data-state="pending"]::before, .b-save[data-state="saving"]::before { background: var(--we-color-warning, #92400E); }
.b-save[data-state="retrying"]::before, .b-save[data-state="rejected"]::before, .b-save[data-state="conflict"]::before { background: var(--we-color-danger); }
.b-save[data-state="retrying"], .b-save[data-state="rejected"], .b-save[data-state="conflict"] { color: var(--we-color-danger); }
.b-chip { font-size: 12px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--we-color-border); color: var(--we-color-textMuted); }
.b-link { font: inherit; font-size: 13px; padding: 0; border: 0; background: none; color: var(--we-color-accent); cursor: pointer; text-decoration: underline; }
.b-count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; margin-left: 6px; padding: 0 5px; border-radius: 999px;
  font-size: 11px; font-weight: 700; background: var(--we-color-accentText); color: var(--we-color-accent); }

/* Buttons */
.b-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 14px; font-weight: 500; padding: 6px 12px;
  border-radius: 8px; border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); cursor: pointer; }
.b-btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--we-color-accent) 45%, var(--we-color-border)); }
.b-btn:disabled { opacity: .5; cursor: not-allowed; }
.b-btn[aria-current="true"], .b-btn[aria-pressed="true"] { border-color: var(--we-color-accent); color: var(--we-color-accent); font-weight: 600;
  background: color-mix(in srgb, var(--we-color-accent) 8%, var(--we-color-background)); }
.b-quiet { border-color: transparent; background: transparent; }
.b-quiet:hover:not(:disabled) { background: var(--we-color-surface); border-color: var(--we-color-border); }
.b-primary, .b-primary[aria-pressed="true"] { border-color: var(--we-color-accent); background: var(--we-color-accent); color: var(--we-color-accentText); font-weight: 600; }
.b-primary:hover:not(:disabled) { filter: brightness(1.08); border-color: var(--we-color-accent); }
.b-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }

/* Columns */
.b-columns { display: grid; grid-template-columns: 272px minmax(0, 1fr) 320px; align-items: start; --b-topbar: 52px; }
.b-columns > .b-panel { position: sticky; top: calc(var(--c-topbar, 0px) + var(--b-topbar)); max-height: calc(100vh - var(--c-topbar, 0px) - var(--b-topbar)); overflow-y: auto; }
.b-panel { padding: 16px; border-right: 1px solid var(--we-color-border); min-width: 0; background: var(--we-color-background); align-self: stretch; }
.b-panel:last-child { border-right: 0; border-left: 1px solid var(--we-color-border); }
.b-panel h2 { font-size: 15px; margin: 16px 0 8px; }
.b-panel h2:first-child { margin-top: 0; }
.b-back { display: inline-block; margin-bottom: 12px; text-decoration: none; }
.b-hint-card { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: 13px; color: var(--we-color-textMuted);
  background: var(--we-color-surface); border: 1px dashed var(--we-color-border); }
.b-fold { margin-top: 8px; border-top: 1px solid var(--we-color-border); padding-top: 12px; }
.b-fold > summary { cursor: pointer; font-weight: 600; font-size: 15px; padding: 4px 0; }
.b-fold[open] > summary { margin-bottom: 8px; }

/* Workspace and the form sheet */
.b-workspace { padding: 28px 24px 64px; min-width: 0; min-height: 100%; box-sizing: border-box; }
.b-canvas { max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; padding: 28px 36px 24px;
  background: var(--we-color-background); color: var(--we-color-text); border: 1px solid var(--we-color-border);
  border-radius: var(--we-form-radius, 12px); box-shadow: 0 1px 2px rgb(16 24 40 / .05), 0 4px 16px rgb(16 24 40 / .06); }
.b-sheet-title { display: block; width: 100%; text-align: left; font: inherit; font-size: 24px; font-weight: 700; line-height: 1.25;
  margin: 0 0 16px; padding: 6px 8px; margin-left: -8px; border: 1px solid transparent; border-radius: 8px; background: none; color: inherit; cursor: pointer; }
.b-sheet-title:hover { background: color-mix(in srgb, var(--we-color-accent) 5%, transparent); }
.b-sheet-title:focus-visible { border-color: var(--we-color-accent); }

/* Questions on the sheet */
.b-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.b-card { position: relative; padding: 14px 16px 2px; margin: 0 -16px 6px; border: 1px solid transparent; border-radius: 10px;
  background: transparent; cursor: pointer; transition: background-color .12s, border-color .12s; }
.b-card[draggable="true"] { cursor: grab; }
/* The canvas shows each question's controls but they are inert: a click anywhere selects the question.
   (Disabled inputs swallow clicks in some browsers, so they must not be the click target.) */
.b-card .we-field, .b-card .we-field * { pointer-events: none; }
.b-card[data-dragged="true"] { opacity: .45; }
.b-card:hover { background: color-mix(in srgb, var(--we-color-accent) 4%, transparent); border-color: color-mix(in srgb, var(--we-color-accent) 25%, transparent); }
.b-card[data-selected="true"] { background: color-mix(in srgb, var(--we-color-accent) 6%, transparent); border-color: var(--we-color-accent);
  box-shadow: inset 3px 0 0 var(--we-color-accent); }
.b-card-tools { display: flex; gap: 2px; align-items: center; position: absolute; top: 8px; right: 8px; margin: 0; padding: 2px;
  border: 1px solid var(--we-color-border); border-radius: 8px; background: var(--we-color-background); box-shadow: 0 1px 3px rgb(16 24 40 / .08);
  opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 1; }
.b-card-tools > * { pointer-events: auto; }
.b-card:hover .b-card-tools, .b-card:focus-within .b-card-tools, .b-card[data-selected="true"] .b-card-tools { opacity: 1; }
@media (hover: none) { .b-card-tools { opacity: 1; } }
.b-tool { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent;
  color: var(--we-color-textMuted); cursor: pointer; }
.b-tool:hover:not(:disabled) { background: var(--we-color-surface); color: var(--we-color-text); }
.b-tool[aria-pressed="true"] { color: var(--we-color-accent); }
.b-tool:disabled { opacity: .35; cursor: not-allowed; }
.b-handle { display: grid; place-items: center; width: 22px; color: var(--we-color-textMuted); cursor: grab; user-select: none; }
.b-drop-line { height: 3px; margin: -4px 0 4px; border-radius: 2px; background: var(--we-color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-color-accent) 20%, transparent); }
.b-dropzone { border: 2px dashed var(--we-color-border); border-radius: 10px; padding: 36px 16px; text-align: center; color: var(--we-color-textMuted); }
.b-dropzone[data-active="true"], .b-canvas[data-dragging="true"] .b-dropzone { border-color: var(--we-color-accent); color: var(--we-color-accent); }
.b-field { display: grid; gap: 4px; margin-bottom: 12px; }
.b-field input:not([type=checkbox]):not([type=radio]), .b-field textarea, .b-field select { font: inherit; padding: 6px; border-radius: var(--we-radius-sm);
  border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); width: 100%; box-sizing: border-box; }
.b-field [aria-invalid="true"] { border-color: var(--we-color-danger); }
.b-inline-error { color: var(--we-color-danger); margin: 0; font-size: 14px; }
.b-muted { color: var(--we-color-textMuted); font-size: 14px; }
.b-badge { color: var(--we-color-textMuted); font-size: 12px; font-style: italic; margin: 0 0 2px; }
.b-issues { margin: 0; padding-left: 20px; font-size: 14px; }
.b-banner { padding: 8px 16px; border-bottom: 1px solid var(--we-color-border); background: var(--we-color-background); }
.b-banner[data-kind="error"] { background: color-mix(in srgb, var(--we-color-danger) 12%, transparent); }
.b-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.b-color { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 0 8px; align-items: start; }
.b-swatch { width: 44px; height: 36px; margin-top: 26px; padding: 2px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-sm); background: var(--we-color-background); }

/* Page tabs above the sheet's questions */
.b-pagetabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--we-color-border); }
.b-pagetab { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); cursor: pointer; }
.b-pagetab[aria-current="page"] { border-color: var(--we-color-accent); color: var(--we-color-accent); font-weight: 600; }
.b-pagetab[data-drop="true"] { background: color-mix(in srgb, var(--we-color-accent) 14%, transparent); border-color: var(--we-color-accent); }
.b-pagetab-add { border-style: dashed; color: var(--we-color-textMuted); }
.b-pagetab:disabled { opacity: .5; cursor: not-allowed; }

/* Field list */
.b-palette { display: grid; gap: 4px; }
.b-search { font: inherit; font-size: 14px; width: 100%; box-sizing: border-box; padding: 7px 10px; margin-bottom: 8px; border-radius: 8px;
  border: 1px solid var(--we-color-border); background: var(--we-color-surface); color: var(--we-color-text); }
.b-tile-group { margin-bottom: 6px; }
.b-tile-heading { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--we-color-textMuted); margin: 10px 0 4px; }
.b-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
.b-tile { display: flex; align-items: center; gap: 8px; font: inherit; font-size: 13px; text-align: left; padding: 6px 8px; cursor: grab;
  border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--we-color-text); min-width: 0; }
.b-tile:hover:not(:disabled) { background: color-mix(in srgb, var(--we-color-accent) 7%, transparent); border-color: color-mix(in srgb, var(--we-color-accent) 30%, transparent); }
.b-tile:disabled { cursor: not-allowed; opacity: .5; }
.b-tile span:last-child { overflow-wrap: anywhere; line-height: 1.2; }
.b-glyph { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; font-size: 11px; font-weight: 700;
  background: color-mix(in srgb, var(--we-color-accent) 10%, transparent); color: var(--we-color-accent); }
.b-palette-hint { font-size: 12px; color: var(--we-color-textMuted); margin: 12px 0 0; }

/* Preview, publish and share */
.b-preview { padding: 16px 24px; }
.b-preview-bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 8px; }
.b-segmented { display: flex; flex-wrap: wrap; gap: 4px 12px; border: 0; margin: 0; padding: 0; }
.b-device { margin: 0 auto; max-width: 100%; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); overflow: hidden; background: var(--we-color-background); }
.b-device[data-device="mobile"] { border-width: 8px; border-radius: 24px; }
.b-publish { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; padding: 16px 24px; align-items: start; }
.b-publish > * { background: var(--we-color-background); border: 1px solid var(--we-color-border); border-radius: 12px; padding: 20px 24px; }
.b-publish h2 { font-size: 18px; margin: 0 0 8px; }
.b-publish h3 { font-size: 15px; margin: 16px 0 4px; }
.b-ok { color: var(--we-color-success, #166534); font-weight: 600; margin: 0; }
.b-result { margin-top: 12px; padding: 8px 12px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); }
.b-result[data-kind="error"] { border-color: var(--we-color-danger); }
.b-versions { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.b-versions li { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center;
  padding: 8px 12px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); background: var(--we-color-background); }
.b-versions li[data-active="true"] { border-color: var(--we-color-accent); }
.b-live { font-size: 13px; font-weight: 600; color: var(--we-color-accent); }

@media (prefers-reduced-motion: reduce) { .b-card, .b-card-tools { transition: none; } }
@media (max-width: 1023px) {
  .b-columns { grid-template-columns: minmax(0, 1fr); }
  .b-columns > .b-panel { position: static; max-height: none; overflow: visible; }
  .b-panel, .b-panel:last-child { border: 0; border-bottom: 1px solid var(--we-color-border); }
  .b-workspace { padding: 16px 12px 32px; }
  .b-canvas { padding: 20px 18px; }
  .b-card { margin: 0 -10px 6px; padding: 12px 10px 2px; }
  .b-publish { grid-template-columns: 1fr; padding: 16px; }
}
`;
