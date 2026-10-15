/** Builder layout: three columns on wide screens, stacked on narrow ones (docs/01 §3). */
export const BUILDER_CSS = `
.b-shell { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
.b-topbar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--we-color-border); background: var(--we-color-surface); position: sticky; top: 0; z-index: 2; }
.b-topbar h1 { font-size: 18px; margin: 0; }
.b-columns { display: grid; grid-template-columns: 240px minmax(0, 1fr) 320px; align-items: start; }
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
@media (max-width: 1023px) {
  .b-columns { grid-template-columns: 1fr; }
  .b-panel, .b-panel:last-child { border: 0; border-bottom: 1px solid var(--we-color-border); }
  .b-canvas { padding: 16px; }
}
`;
