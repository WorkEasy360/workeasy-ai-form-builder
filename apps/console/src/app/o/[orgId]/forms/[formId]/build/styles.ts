/** Builder layout: three columns on wide screens, stacked on narrow ones (docs/01 §3). */
export const BUILDER_CSS = `
.b-shell { display: grid; grid-template-rows: auto 1fr; }
.b-topbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--we-color-border); background: var(--we-color-surface); position: sticky; top: var(--c-topbar, 0); z-index: 10; }
.b-topbar h1 { font-size: 18px; margin: 0; }
.b-columns { display: grid; grid-template-columns: 288px minmax(0, 1fr) 320px; align-items: start; --b-topbar: 52px; }
.b-columns > .b-panel { position: sticky; top: calc(var(--c-topbar, 0px) + var(--b-topbar)); max-height: calc(100vh - var(--c-topbar, 0px) - var(--b-topbar)); overflow-y: auto; }
.b-panel { padding: 16px; border-right: 1px solid var(--we-color-border); min-width: 0; }
.b-panel:last-child { border-right: 0; border-left: 1px solid var(--we-color-border); }
.b-panel h2 { font-size: 15px; margin: 16px 0 8px; }
.b-panel h2:first-child { margin-top: 0; }
.b-canvas { padding: 24px; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; }
.b-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.b-row { display: flex; gap: 4px; align-items: center; }
.b-row > .b-grow { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-btn { font: inherit; padding: 4px 8px; border-radius: var(--we-radius-sm); border: 1px solid var(--we-color-border);
  background: var(--we-color-background); color: var(--we-color-text); cursor: pointer; }
.b-btn:disabled { opacity: .5; cursor: not-allowed; }
.b-btn[aria-current="true"], .b-btn[aria-pressed="true"] { border-color: var(--we-color-accent); font-weight: 600; }
.b-primary { border-color: var(--we-color-accent); background: var(--we-color-accent); color: var(--we-color-accentText); }
.b-palette { display: grid; gap: 4px; }
.b-card { border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); padding: 12px 16px 4px; margin-bottom: 12px; background: var(--we-color-background); }
.b-card[data-selected="true"] { border-color: var(--we-color-accent); box-shadow: 0 0 0 1px var(--we-color-accent); }
.b-card-tools { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; margin-bottom: 8px; }
.b-field { display: grid; gap: 4px; margin-bottom: 12px; }
.b-field input:not([type=checkbox]), .b-field textarea, .b-field select { font: inherit; padding: 6px; border-radius: var(--we-radius-sm);
  border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); width: 100%; box-sizing: border-box; }
.b-field [aria-invalid="true"] { border-color: var(--we-color-danger); }
.b-inline-error { color: var(--we-color-danger); margin: 0; font-size: 14px; }
.b-muted { color: var(--we-color-textMuted); font-size: 14px; }
.b-badge { color: var(--we-color-textMuted); font-size: 13px; font-style: italic; margin: 0 0 4px; }
.b-issues { margin: 0; padding-left: 20px; font-size: 14px; }
.b-banner { padding: 8px 16px; border-bottom: 1px solid var(--we-color-border); }
.b-banner[data-kind="error"] { background: color-mix(in srgb, var(--we-color-danger) 12%, transparent); }
.b-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.b-color { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 0 8px; align-items: start; }
.b-swatch { width: 44px; height: 36px; margin-top: 26px; padding: 2px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-sm); background: var(--we-color-background); }
.b-canvas { border-radius: var(--we-form-radius); }
.b-preview { padding: 16px 24px; }
.b-preview-bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 8px; }
.b-segmented { display: flex; flex-wrap: wrap; gap: 4px 12px; border: 0; margin: 0; padding: 0; }
.b-device { margin: 0 auto; max-width: 100%; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); overflow: hidden; }
.b-device[data-device="mobile"] { border-width: 8px; border-radius: 24px; }
.b-publish { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; padding: 16px 24px; align-items: start; }
.b-publish h2 { font-size: 18px; margin: 0 0 8px; }
.b-publish h3 { font-size: 15px; margin: 16px 0 4px; }
.b-ok { color: var(--we-color-success, #15803D); font-weight: 600; margin: 0; }
.b-result { margin-top: 12px; padding: 8px 12px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); }
.b-result[data-kind="error"] { border-color: var(--we-color-danger); }
.b-versions { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.b-versions li { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center;
  padding: 8px 12px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); }
.b-versions li[data-active="true"] { border-color: var(--we-color-accent); }
.b-live { font-size: 13px; font-weight: 600; color: var(--we-color-accent); }
.b-search { font: inherit; width: 100%; padding: 6px 8px; margin-bottom: 8px; border-radius: var(--we-radius-md);
  border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); }
.b-tile-group { margin-bottom: 12px; }
.b-tile-heading { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--we-color-textMuted); margin: 8px 0 6px; }
.b-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.b-tile { display: flex; align-items: center; gap: 8px; font: inherit; font-size: 14px; text-align: left; padding: 8px; cursor: grab;
  border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); background: var(--we-color-background); color: var(--we-color-text); min-width: 0; }
.b-tile:hover { border-color: var(--we-color-accent); background: color-mix(in srgb, var(--we-color-accent) 6%, var(--we-color-background)); }
.b-tile:disabled { cursor: not-allowed; opacity: .5; }
.b-tile span:last-child { overflow-wrap: anywhere; line-height: 1.25; }
.b-glyph { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 6px; font-size: 13px; font-weight: 700;
  background: color-mix(in srgb, var(--we-color-accent) 12%, transparent); color: var(--we-color-accent); }
.b-card { position: relative; cursor: default; transition: box-shadow .12s, border-color .12s; }
.b-card[draggable="true"] { cursor: grab; }
.b-card[data-dragged="true"] { opacity: .45; }
.b-card:hover { border-color: color-mix(in srgb, var(--we-color-accent) 45%, var(--we-color-border)); }
.b-card-tools { opacity: 0; transition: opacity .12s; position: absolute; top: 6px; right: 8px; margin: 0; pointer-events: none; }
.b-card-tools > * { pointer-events: auto; }
.b-card-tools .b-btn { background: var(--we-color-background); font-size: 13px; padding: 2px 8px; }
.b-card:hover .b-card-tools, .b-card:focus-within .b-card-tools, .b-card[data-selected="true"] .b-card-tools { opacity: 1; }
@media (hover: none) { .b-card-tools { opacity: 1; } }
.b-handle { margin-right: 4px; align-self: center; color: var(--we-color-textMuted); cursor: grab; font-size: 18px; line-height: 1; user-select: none; }
.b-drop-line { height: 4px; margin: -8px 0 8px; border-radius: 2px; background: var(--we-color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-color-accent) 20%, transparent); }
.b-dropzone { border: 2px dashed var(--we-color-border); border-radius: var(--we-radius-md); padding: 32px 16px; text-align: center; color: var(--we-color-textMuted); }
.b-dropzone[data-active="true"], .b-canvas[data-dragging="true"] .b-dropzone { border-color: var(--we-color-accent); color: var(--we-color-accent); }
.b-pagetabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
.b-pagetab { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--we-color-border);
  background: var(--we-color-background); color: var(--we-color-text); cursor: pointer; }
.b-pagetab[aria-current="page"] { border-color: var(--we-color-accent); color: var(--we-color-accent); font-weight: 600; }
.b-pagetab[data-drop="true"] { background: color-mix(in srgb, var(--we-color-accent) 14%, transparent); border-color: var(--we-color-accent); }
@media (prefers-reduced-motion: reduce) { .b-card, .b-card-tools { transition: none; } }
@media (max-width: 1023px) {
  .b-columns { grid-template-columns: minmax(0, 1fr); }
  .b-columns > .b-panel { position: static; max-height: none; overflow: visible; }
  .b-panel, .b-panel:last-child { border: 0; border-bottom: 1px solid var(--we-color-border); }
  .b-canvas { padding: 16px; }
  .b-publish { grid-template-columns: 1fr; padding: 16px; }
}
`;
