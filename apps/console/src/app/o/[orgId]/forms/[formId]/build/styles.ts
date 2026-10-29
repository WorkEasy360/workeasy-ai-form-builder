/**
 * Builder layout (docs/01 §3): a quiet toolbar, the field list on the left,
 * the form as a sheet on a grey workspace in the middle, and properties on
 * the right; stacked on narrow screens. Questions show their tools only on
 * hover, focus or selection, so the form itself stays readable.
 *
 * Two token scopes: the builder's own chrome uses the WorkEasy360 `--we-*`
 * tokens; everything inside the canvas (`.b-canvas`, themed by `themeStyle`)
 * uses the form's `--we-color-*` theme, so it keeps contrast on any theme.
 */
export const BUILDER_CSS = `
.b-shell { display: grid; grid-template-rows: auto 1fr; background: var(--we-background); min-height: calc(100vh - 152px); }

/* Toolbar */
.b-topbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--we-border); background: var(--we-surface);
  position: sticky; top: var(--c-topbar, 0); z-index: 10; }
.b-bar-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.b-icon-btn { width: var(--we-control-height); height: var(--we-control-height); display: grid; place-items: center; padding: 0; border: 1px solid transparent;
  border-radius: var(--we-radius-md); background: transparent; color: var(--we-text-primary); cursor: pointer;
  transition: background-color var(--we-duration-fast) var(--we-ease), border-color var(--we-duration-fast) var(--we-ease); }
.b-icon-btn:hover:not(:disabled) { background: var(--we-surface-hover); border-color: var(--we-border); }
.b-icon-btn:disabled { color: var(--we-text-secondary); opacity: .45; cursor: not-allowed; }
.b-save { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; font-size: var(--we-text-sm); color: var(--we-text-secondary); }
.b-save::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--we-success); }
.b-save[data-state="pending"]::before, .b-save[data-state="saving"]::before { background: var(--we-warning); }
.b-save[data-state="retrying"]::before, .b-save[data-state="rejected"]::before, .b-save[data-state="conflict"]::before { background: var(--we-error); }
.b-save[data-state="retrying"], .b-save[data-state="rejected"], .b-save[data-state="conflict"] { color: var(--we-error-fg); }
.b-chip { font-size: var(--we-text-xs); font-weight: 500; padding: 1px 8px; border-radius: var(--we-radius-full); background: var(--we-surface-muted); color: var(--we-text-body); }
.b-link { font: inherit; font-size: var(--we-text-sm); padding: 0; border: 0; background: none; color: var(--we-link); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.b-count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; margin-left: 6px; padding: 0 5px; border-radius: var(--we-radius-full);
  font-size: 11px; font-weight: 700; background: var(--we-primary); color: var(--we-on-primary); }
.b-primary .b-count { background: var(--we-on-accent); color: var(--we-accent); }

/* Buttons */
.b-btn { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: var(--we-text-base); font-weight: 500;
  min-height: var(--we-control-height-sm); padding: 0 12px; border-radius: var(--we-radius-md); border: 1px solid var(--we-border);
  background: var(--we-surface); color: var(--we-text-primary); cursor: pointer;
  transition: background-color var(--we-duration-fast) var(--we-ease), border-color var(--we-duration-fast) var(--we-ease); }
.b-btn:hover:not(:disabled) { background: var(--we-surface-hover); border-color: var(--we-border-strong); }
.b-btn:disabled { opacity: .5; cursor: not-allowed; }
.b-btn[aria-current="true"], .b-btn[aria-pressed="true"] { border-color: var(--we-primary); color: var(--we-primary); font-weight: 600; background: var(--we-surface-selected); }
.b-quiet { border-color: transparent; background: transparent; }
.b-quiet:hover:not(:disabled) { background: var(--we-surface-hover); border-color: transparent; }
.b-primary, .b-primary[aria-pressed="true"] { border-color: var(--we-accent); background: var(--we-accent); color: var(--we-on-accent); font-weight: 600; }
.b-primary:hover:not(:disabled) { background: var(--we-accent-hover); border-color: var(--we-accent-hover); }
.b-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; }

/* Columns */
.b-columns { display: grid; grid-template-columns: 272px minmax(0, 1fr) 320px; align-items: start; --b-topbar: 52px; }
.b-columns > .b-panel { position: sticky; top: calc(var(--c-topbar, 0px) + var(--b-topbar)); max-height: calc(100vh - var(--c-topbar, 0px) - var(--b-topbar)); overflow-y: auto; }
.b-panel { padding: 16px; border-right: 1px solid var(--we-border); min-width: 0; background: var(--we-surface); align-self: stretch; }
.b-panel:last-child { border-right: 0; border-left: 1px solid var(--we-border); }
.b-panel h2 { font-size: var(--we-text-md); margin: 16px 0 8px; }
.b-panel h2:first-child { margin-top: 0; }
.b-back { display: inline-block; margin-bottom: 12px; text-decoration: none; }
.b-hint-card { margin: 0 0 16px; padding: 10px 12px; border-radius: var(--we-radius-md); font-size: var(--we-text-sm); color: var(--we-text-secondary);
  background: var(--we-background); border: 1px dashed var(--we-border-strong); }
.b-fold { margin-top: 8px; border-top: 1px solid var(--we-border); padding-top: 12px; }
.b-fold > summary { cursor: pointer; font-weight: 600; font-size: var(--we-text-base); color: var(--we-text-primary); padding: 4px 0; }
.b-fold[open] > summary { margin-bottom: 8px; }

/* Workspace and the form sheet (themed by the form) */
.b-workspace { padding: 28px 24px 64px; min-width: 0; min-height: 100%; box-sizing: border-box; }
.b-canvas { max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; padding: 28px 36px 24px;
  background: var(--we-color-background); color: var(--we-color-text); border: 1px solid var(--we-border);
  border-radius: var(--we-form-radius, 12px); box-shadow: var(--we-shadow-md); }
.b-sheet-title { display: block; width: 100%; text-align: left; font: inherit; font-size: 24px; font-weight: 600; line-height: 1.25;
  margin: 0 0 16px; padding: 6px 8px; margin-left: -8px; border: 1px solid transparent; border-radius: 8px; background: none; color: inherit; cursor: pointer; }
.b-sheet-title:hover { background: color-mix(in srgb, var(--we-color-accent) 5%, transparent); }
.b-sheet-title:focus-visible { border-color: var(--we-color-accent); }

/* Questions on the sheet */
.b-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.b-card { position: relative; padding: 14px 16px 2px; margin: 0 -16px 6px; border: 1px solid transparent; border-radius: 10px;
  background: transparent; cursor: pointer; transition: background-color var(--we-duration-fast) var(--we-ease), border-color var(--we-duration-fast) var(--we-ease); }
.b-card[draggable="true"] { cursor: grab; }
/* The canvas shows each question's controls but they are inert: a click anywhere selects the question.
   (Disabled inputs swallow clicks in some browsers, so they must not be the click target.) */
.b-card .we-field, .b-card .we-field * { pointer-events: none; }
.b-card[data-dragged="true"] { opacity: .45; }
.b-card:hover { background: color-mix(in srgb, var(--we-color-accent) 4%, transparent); border-color: color-mix(in srgb, var(--we-color-accent) 25%, transparent); }
.b-card[data-selected="true"] { background: color-mix(in srgb, var(--we-color-accent) 6%, transparent); border-color: var(--we-color-accent);
  box-shadow: inset 3px 0 0 var(--we-color-accent); }
.b-card-tools { display: flex; gap: 2px; align-items: center; position: absolute; top: 8px; right: 8px; margin: 0; padding: 2px;
  border: 1px solid var(--we-color-border); border-radius: 8px; background: var(--we-color-background); box-shadow: var(--we-shadow-sm);
  opacity: 0; pointer-events: none; transition: opacity var(--we-duration-fast) var(--we-ease); z-index: 1; }
.b-card-tools > * { pointer-events: auto; }
.b-card:hover .b-card-tools, .b-card:focus-within .b-card-tools, .b-card[data-selected="true"] .b-card-tools { opacity: 1; }
@media (hover: none) { .b-card-tools { opacity: 1; } }
.b-tool { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent;
  color: var(--we-color-textMuted); cursor: pointer; }
.b-tool:hover:not(:disabled) { background: color-mix(in srgb, var(--we-color-text) 8%, transparent); color: var(--we-color-text); }
.b-tool[aria-pressed="true"] { color: var(--we-color-accent); }
.b-tool:disabled { opacity: .35; cursor: not-allowed; }
.b-handle { display: grid; place-items: center; width: 22px; color: var(--we-color-textMuted); cursor: grab; user-select: none; }
.b-drop-line { height: 3px; margin: -4px 0 4px; border-radius: 2px; background: var(--we-color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-color-accent) 20%, transparent); }
.b-dropzone { border: 2px dashed var(--we-color-border); border-radius: 10px; padding: 36px 16px; text-align: center; color: var(--we-color-textMuted); }
.b-dropzone[data-active="true"], .b-canvas[data-dragging="true"] .b-dropzone { border-color: var(--we-color-accent); color: var(--we-color-accent); }

/* Properties */
.b-field { display: grid; gap: 4px; margin-bottom: 12px; }
.b-field > label, .b-field > legend { font-size: var(--we-text-sm); font-weight: 500; color: var(--we-text-primary); }
.b-field input:not([type=checkbox]):not([type=radio]):not([type=color]), .b-field textarea, .b-field select { font: inherit; min-height: var(--we-control-height-sm); padding: 5px 8px;
  border-radius: var(--we-radius-md); border: 1px solid var(--we-border-strong); background: var(--we-surface); color: var(--we-text-primary); width: 100%; box-sizing: border-box; }
.b-field input:focus-visible, .b-field textarea:focus-visible, .b-field select:focus-visible { outline: none; border-color: var(--we-focus);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-focus) 25%, transparent); }
.b-field input:disabled, .b-field textarea:disabled, .b-field select:disabled { background: var(--we-surface-muted); color: var(--we-text-secondary); }
.b-field [aria-invalid="true"] { border-color: var(--we-error); }
.b-inline-error { color: var(--we-color-danger); margin: 0; font-size: var(--we-text-sm); }
.b-muted { color: var(--we-color-textMuted); font-size: var(--we-text-sm); }
.b-badge { color: var(--we-color-textMuted); font-size: 12px; font-style: italic; margin: 0 0 2px; }
.b-issues { margin: 0; padding-left: 20px; font-size: var(--we-text-sm); }
.b-banner { padding: 8px 16px; border-bottom: 1px solid var(--we-border); background: var(--we-info-bg); color: var(--we-info-fg); }
.b-banner[data-kind="error"] { background: var(--we-error-bg); color: var(--we-error-fg); }
.b-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.b-color { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 0 8px; align-items: start; }
.b-swatch { width: 44px; height: 36px; margin-top: 26px; padding: 2px; border: 1px solid var(--we-border-strong); border-radius: var(--we-radius-md); background: var(--we-surface); }

/* Page tabs above the sheet's questions (themed by the form) */
.b-pagetabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--we-color-border); }
.b-pagetab { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); cursor: pointer; }
.b-pagetab[aria-current="page"] { border-color: var(--we-color-accent); color: var(--we-color-accent); font-weight: 600; }
.b-pagetab[data-drop="true"] { background: color-mix(in srgb, var(--we-color-accent) 14%, transparent); border-color: var(--we-color-accent); }
.b-pagetab-add { border-style: dashed; color: var(--we-color-textMuted); }
.b-pagetab:disabled { opacity: .5; cursor: not-allowed; }

/* Field list */
.b-palette { display: grid; gap: 4px; }
.b-search { font: inherit; font-size: var(--we-text-base); width: 100%; box-sizing: border-box; min-height: var(--we-control-height-sm); padding: 5px 10px; margin-bottom: 8px;
  border-radius: var(--we-radius-md); border: 1px solid var(--we-border-strong); background: var(--we-surface); color: var(--we-text-primary); }
.b-search:focus-visible { outline: none; border-color: var(--we-focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-focus) 25%, transparent); }
.b-tile-group { margin-bottom: 6px; }
.b-tile-heading { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--we-text-secondary); margin: 10px 0 4px; }
.b-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
.b-tile { display: flex; align-items: center; gap: 8px; font: inherit; font-size: var(--we-text-sm); text-align: left; padding: 6px 8px; cursor: grab;
  border: 1px solid transparent; border-radius: var(--we-radius-md); background: transparent; color: var(--we-text-body); min-width: 0;
  transition: background-color var(--we-duration-fast) var(--we-ease), border-color var(--we-duration-fast) var(--we-ease); }
.b-tile:hover:not(:disabled) { background: var(--we-surface-hover); border-color: var(--we-border); color: var(--we-text-primary); }
.b-tile:disabled { cursor: not-allowed; opacity: .5; }
.b-tile span:last-child { overflow-wrap: anywhere; line-height: 1.2; }
.b-glyph { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; font-size: 11px; font-weight: 700;
  background: var(--we-surface-muted); color: var(--we-primary); }
.b-tile:hover:not(:disabled) .b-glyph { background: var(--we-accent-soft); color: var(--we-accent-strong); }
.b-palette-hint { font-size: var(--we-text-xs); color: var(--we-text-secondary); margin: 12px 0 0; }

/* Preview, publish and share */
.b-preview { padding: 16px 24px; }
.b-preview-bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 8px; }
.b-segmented { display: flex; flex-wrap: wrap; gap: 4px 12px; border: 0; margin: 0; padding: 0; }
.b-device { margin: 0 auto; max-width: 100%; border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); overflow: hidden; background: var(--we-surface); box-shadow: var(--we-shadow-sm); }
.b-device[data-device="mobile"] { border: 8px solid var(--we-primary); border-radius: 24px; }
.b-publish { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; padding: 24px; align-items: start; }
.b-publish > * { background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); padding: 20px 24px; box-shadow: var(--we-shadow-xs); }
.b-publish h2 { font-size: var(--we-text-lg); margin: 0 0 8px; }
.b-publish h3 { font-size: var(--we-text-base); margin: 16px 0 4px; }
.b-ok { color: var(--we-success-fg); font-weight: 600; margin: 0; }
.b-result { margin-top: 12px; padding: 8px 12px; border: 1px solid var(--we-border); border-radius: var(--we-radius-md); }
.b-result[data-kind="error"] { border-color: var(--we-error); background: var(--we-error-bg); color: var(--we-error-fg); }
.b-versions { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.b-versions li { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center;
  padding: 8px 12px; border: 1px solid var(--we-border); border-radius: var(--we-radius-md); background: var(--we-surface); }
.b-versions li[data-active="true"] { border-color: var(--we-primary); box-shadow: inset 3px 0 0 var(--we-accent); }
.b-live { font-size: var(--we-text-sm); font-weight: 600; color: var(--we-success-fg); }

@media (prefers-reduced-motion: reduce) { .b-card, .b-card-tools { transition: none; } }
@media (max-width: 1023px) {
  .b-columns { grid-template-columns: minmax(0, 1fr); }
  .b-columns > .b-panel { position: static; max-height: none; overflow: visible; }
  .b-panel, .b-panel:last-child { border: 0; border-bottom: 1px solid var(--we-border); }
  .b-workspace { padding: 16px 12px 32px; }
  .b-canvas { padding: 20px 18px; }
  .b-card { margin: 0 -10px 6px; padding: 12px 10px 2px; }
  .b-publish { grid-template-columns: 1fr; padding: 16px; }
}
`;
