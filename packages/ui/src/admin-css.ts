import { tokensCss } from "./tokens";

/**
 * The shared WorkEasy360 style vocabulary (docs/shared/workeasy360-design-system.md).
 * Every product page is built from these classes, prefixed `c-`, so every
 * product looks and behaves alike: a navy sidebar and white top bar around a
 * page that opens with a page header, then a toolbar, then cards, tables or
 * forms. Every value comes from a `--we-*` token; nothing here hardcodes a
 * colour. Product-specific styles live in the product, not here.
 */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--we-font-family);font-size:var(--we-font-size-base);line-height:var(--we-line-height-normal);
  background:var(--we-background);color:var(--we-text-body);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
:focus-visible{outline:2px solid var(--we-focus);outline-offset:2px}
a{color:var(--we-link);text-underline-offset:2px}
h1,h2,h3,h4{color:var(--we-text-primary);line-height:var(--we-line-height-tight);letter-spacing:-.01em;font-weight:var(--we-font-weight-semibold)}
img,svg{max-width:100%}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;scroll-behavior:auto!important}}
`;

export const ADMIN_CSS = `
:root { --c-sidebar: var(--we-size-sidebar); --c-topbar: var(--we-size-topbar);
  --c-transition: background-color var(--we-motion-fast) var(--we-motion-ease), border-color var(--we-motion-fast) var(--we-motion-ease),
    color var(--we-motion-fast) var(--we-motion-ease), box-shadow var(--we-motion-fast) var(--we-motion-ease);
  --c-ring: 0 0 0 3px color-mix(in srgb, var(--we-focus) 18%, transparent); }

/* App shell ------------------------------------------------------------- */
.c-app { display: grid; grid-template-columns: var(--c-sidebar) minmax(0, 1fr); grid-template-rows: var(--c-topbar) 1fr; min-height: 100vh; }
.c-topbar { grid-column: 2; display: flex; align-items: center; gap: 12px; padding: 0 24px; border-bottom: 1px solid var(--we-border);
  background: var(--we-surface); position: sticky; top: 0; z-index: 20; }
.c-topbar-start { display: flex; align-items: center; gap: 8px; min-width: 0; }
.c-topbar-end { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.c-topbar-divider { width: 1px; height: 24px; background: var(--we-border); margin: 0 6px; }
.c-sidebar { --we-focus: var(--we-accent); grid-row: 1 / -1; grid-column: 1; background: var(--we-sidebar); color: var(--we-sidebar-text);
  border-right: 1px solid var(--we-sidebar-border); position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; padding: 0 12px 16px; }
.c-sidebar-brand { display: flex; align-items: center; gap: 10px; height: var(--c-topbar); padding: 0 6px; color: var(--we-sidebar-active); text-decoration: none;
  font-weight: var(--we-font-weight-semibold); font-size: 15px; letter-spacing: -.01em; flex: none; border-bottom: 1px solid var(--we-sidebar-hover); margin: 0 -12px; padding: 0 18px; }
.c-sidebar-brand small { display: block; font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-medium); letter-spacing: 0; color: var(--we-sidebar-muted); }
.c-sidebar-brand .c-brand-dot { color: var(--we-accent); }
.c-nav-group { margin-top: 16px; }
.c-nav-label { font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-medium); color: var(--we-sidebar-muted); margin: 0 10px 4px; }
.c-nav { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.c-nav a { position: relative; display: flex; align-items: center; gap: 10px; min-height: var(--we-size-nav-item); padding: 0 10px; border-radius: var(--we-radius-md);
  color: var(--we-sidebar-text); text-decoration: none; font-size: var(--we-font-size-base); font-weight: var(--we-font-weight-medium); transition: var(--c-transition); }
.c-nav a:hover { background: var(--we-sidebar-hover); color: var(--we-sidebar-active); }
.c-nav a[aria-current="page"] { background: var(--we-sidebar-selected); color: var(--we-sidebar-active); font-weight: var(--we-font-weight-semibold); }
.c-nav a[aria-current="page"]::before { content: ""; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--we-accent); }
.c-nav a[aria-current="page"] svg { color: var(--we-accent); }
.c-nav svg { flex: none; width: var(--we-size-icon); height: var(--we-size-icon); }
.c-nav-tag { margin-left: auto; font-size: 11px; font-weight: var(--we-font-weight-semibold); padding: 1px 7px; border-radius: var(--we-radius-pill);
  background: var(--we-ai-soft); color: var(--we-ai-text); }
.c-sidebar-foot { margin-top: auto; padding-top: 16px; }
.c-main { min-width: 0; grid-column: 2; }
.c-main:focus { outline: none; }
.c-skip { position: absolute; left: 8px; top: -48px; z-index: 100; padding: 8px 12px; border-radius: var(--we-radius-md);
  background: var(--we-primary); color: var(--we-on-primary); font-weight: var(--we-font-weight-semibold); }
.c-skip:focus { top: 8px; }
.c-store-chip { display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-weight: var(--we-font-weight-semibold); font-size: var(--we-font-size-base); color: var(--we-text-primary); }
.c-store-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-avatar { width: 30px; height: 30px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-semibold);
  color: var(--we-on-accent); background: var(--we-accent); }
.c-store-initial { width: 26px; height: 26px; border-radius: var(--we-radius-sm); display: inline-grid; place-items: center; flex: none; font-size: var(--we-font-size-sm); font-weight: var(--we-font-weight-semibold);
  color: var(--we-on-primary); background: var(--we-primary); }
.c-btn.c-menu-toggle { display: none; }
@media (max-width: 959px) {
  .c-app { grid-template-columns: minmax(0, 1fr); grid-template-rows: var(--c-topbar) 1fr; }
  .c-topbar, .c-main { grid-column: 1; }
  .c-topbar { padding: 0 12px; gap: 8px; }
  .c-sidebar { position: fixed; inset: 0 auto 0 0; width: min(84vw, 300px); z-index: 40; transform: translateX(-100%); transition: transform var(--we-motion-base) var(--we-motion-ease); }
  .c-app[data-nav-open="true"] .c-sidebar { transform: none; box-shadow: var(--we-shadow-lg); }
  .c-app[data-nav-open="true"]::after { content: ""; position: fixed; inset: 0; background: var(--we-overlay); z-index: 30; }
  .c-btn.c-menu-toggle { display: inline-flex; }
  .c-hide-sm { display: none !important; }
}

/* Global search in the top bar: jump to any module or page. */
.c-topsearch { position: relative; flex: 0 1 340px; min-width: 0; }
.c-topsearch .c-input { height: 34px; padding-left: 34px; padding-right: 44px; background: var(--we-background); }
.c-topsearch > svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--we-text-secondary); pointer-events: none; }
.c-topsearch .c-kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.c-kbd { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 5px; border: 1px solid var(--we-border); border-radius: var(--we-radius-sm);
  background: var(--we-surface); color: var(--we-text-secondary); font: var(--we-font-weight-medium) 11px/1 var(--we-font-family); }
.c-listbox { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 30; margin: 0; padding: 6px; list-style: none; max-height: min(420px, 70vh); overflow-y: auto;
  background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); box-shadow: var(--we-shadow-lg); }
.c-listbox [role="option"] { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--we-radius-md); cursor: pointer; color: var(--we-text-primary); }
.c-listbox [role="option"] svg { color: var(--we-text-secondary); flex: none; }
.c-listbox [role="option"] small { margin-left: auto; color: var(--we-text-secondary); font-size: var(--we-font-size-xs); white-space: nowrap; }
.c-listbox [role="option"][aria-selected="true"] { background: var(--we-surface-muted); }
.c-listbox [role="option"][aria-selected="true"] small { color: var(--we-text-body); }
.c-listbox-empty { padding: 10px; color: var(--we-text-secondary); font-size: var(--we-font-size-sm); }
@media (max-width: 959px) { .c-topsearch { display: none; } }

/* Icon button with a count (notifications). */
.c-icon-count { position: relative; }
.c-count { position: absolute; top: 2px; right: 1px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: var(--we-radius-pill); display: grid; place-items: center;
  font-size: 10.5px; font-weight: var(--we-font-weight-semibold); font-variant-numeric: tabular-nums; background: var(--we-error); color: #fff; border: 2px solid var(--we-surface); box-sizing: content-box; }
.c-notices { min-width: 300px; }
.c-notices a { align-items: flex-start; }
.c-notices a > span { display: grid; gap: 1px; }
.c-notices a small { color: var(--we-text-secondary); font-size: var(--we-font-size-xs); }
.c-notice-dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; flex: none; background: var(--we-warning); }
.c-notice-dot[data-tone="error"] { background: var(--we-error); }
.c-notice-dot[data-tone="info"] { background: var(--we-info); }

/* Page skeleton: header → toolbar → content --------------------------------- */
.c-page { max-width: 1200px; margin: 0 auto; padding: 32px 24px 48px; }
/* Narrow pages keep the same left edge as every other page; only their content is capped. */
.c-page-narrow > * { max-width: 880px; }
.c-page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; margin-bottom: 24px; }
.c-page-head h1 { font-size: var(--we-font-size-xl); margin: 0; font-weight: var(--we-font-weight-semibold); letter-spacing: -.015em; }
.c-page-eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-semibold); letter-spacing: .04em; text-transform: uppercase;
  color: var(--we-text-secondary); margin-bottom: 6px; }
.c-page-eyebrow svg { color: var(--we-accent-strong); }
.c-subtitle { color: var(--we-text-secondary); margin: 6px 0 0; max-width: 70ch; }
.c-page-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.c-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px; }
.c-section { margin-top: 32px; }
.c-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.c-section-head h2 { font-size: var(--we-font-size-lg); margin: 0; }
@media (max-width: 959px) { .c-page { padding: 24px 16px 40px; } .c-page-head h1 { font-size: 22px; } }

/* Tabs ---------------------------------------------------------------------- */
.c-tabs { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid var(--we-border); margin-bottom: 24px; }
.c-tabs a { padding: 10px 12px; color: var(--we-text-secondary); text-decoration: none; border-bottom: 2px solid transparent; white-space: nowrap; font-weight: var(--we-font-weight-medium); margin-bottom: -1px; transition: var(--c-transition); }
.c-tabs a:hover { color: var(--we-text-primary); }
.c-tabs a[aria-current="page"] { color: var(--we-text-primary); border-bottom-color: var(--we-accent); font-weight: var(--we-font-weight-semibold); }

/* Buttons ------------------------------------------------------------------- */
.c-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: var(--we-size-control); font: inherit; font-size: var(--we-font-size-base); font-weight: var(--we-font-weight-medium);
  padding: 0 14px; border-radius: var(--we-radius-md); border: 1px solid var(--we-border-strong); background: var(--we-surface);
  color: var(--we-text-primary); cursor: pointer; text-decoration: none; line-height: 1.2; white-space: nowrap; transition: var(--c-transition); }
.c-btn:hover { background: var(--we-surface-muted); }
.c-btn:active { background: color-mix(in srgb, var(--we-text-primary) 8%, var(--we-surface)); }
.c-btn:disabled, .c-btn[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.c-btn:disabled:hover, .c-btn[aria-disabled="true"]:hover { background: var(--we-surface); }
.c-btn-primary, .c-btn-brand { background: var(--we-accent); border-color: var(--we-accent); color: var(--we-on-accent); font-weight: var(--we-font-weight-semibold); }
.c-btn-primary:hover, .c-btn-brand:hover { background: var(--we-accent-hover); border-color: var(--we-accent-hover); }
.c-btn-primary:active, .c-btn-brand:active { background: var(--we-accent-hover); }
.c-btn-primary:disabled:hover, .c-btn-brand:disabled:hover { background: var(--we-accent); }
.c-btn-dark { background: var(--we-primary); border-color: var(--we-primary); color: var(--we-on-primary); }
.c-btn-dark:hover { background: var(--we-primary-hover); border-color: var(--we-primary-hover); }
.c-btn-danger { color: var(--we-error-text); border-color: color-mix(in srgb, var(--we-error) 45%, var(--we-border)); }
.c-btn-danger:hover { background: var(--we-error-soft); }
.c-btn-ghost { border-color: transparent; background: transparent; color: var(--we-text-body); }
.c-btn-ghost:hover { background: var(--we-surface-muted); color: var(--we-text-primary); }
.c-btn-sm { min-height: var(--we-size-control-sm); padding: 0 10px; font-size: var(--we-font-size-sm); }
.c-btn-icon { padding: 0; width: var(--we-size-control); }
.c-btn-sm.c-btn-icon { width: var(--we-size-control-sm); }
.c-link-btn { font: inherit; padding: 0; border: 0; background: none; color: var(--we-link); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }

/* Inputs -------------------------------------------------------------------- */
.c-form { display: grid; gap: 16px; }
.c-form-row { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.c-field { display: grid; gap: 6px; align-content: start; }
.c-label { font-weight: var(--we-font-weight-medium); font-size: var(--we-font-size-sm); color: var(--we-text-primary); }
.c-label small { font-weight: var(--we-font-weight-regular); color: var(--we-text-secondary); }
.c-hint { color: var(--we-text-secondary); font-size: var(--we-font-size-sm); margin: 0; }
.c-input, .c-select, .c-textarea { font: inherit; font-size: var(--we-font-size-base); min-height: var(--we-size-control); padding: 7px 12px; border-radius: var(--we-radius-md);
  border: 1px solid var(--we-border-input); background: var(--we-surface); color: var(--we-text-primary); width: 100%; transition: var(--c-transition); }
.c-input::placeholder, .c-textarea::placeholder { color: var(--we-text-secondary); }
.c-input:hover:not(:focus):not(:disabled), .c-select:hover:not(:focus):not(:disabled), .c-textarea:hover:not(:focus):not(:disabled) { border-color: var(--we-text-secondary); }
.c-input:focus, .c-select:focus, .c-textarea:focus { outline: none; border-color: var(--we-focus); box-shadow: var(--c-ring); }
.c-input:disabled, .c-select:disabled, .c-textarea:disabled { background: var(--we-surface-muted); color: var(--we-text-secondary); cursor: not-allowed; }
.c-input[aria-invalid="true"], .c-select[aria-invalid="true"], .c-textarea[aria-invalid="true"] { border-color: var(--we-error); }
.c-input[aria-invalid="true"]:focus, .c-textarea[aria-invalid="true"]:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-error) 18%, transparent); }
.c-input-group { display: flex; align-items: stretch; border: 1px solid var(--we-border-input); border-radius: var(--we-radius-md); background: var(--we-surface); overflow: hidden; transition: var(--c-transition); }
.c-input-group:focus-within { border-color: var(--we-focus); box-shadow: var(--c-ring); }
.c-input-group > span { display: flex; align-items: center; padding: 0 10px; color: var(--we-text-secondary); background: var(--we-background);
  font-size: var(--we-font-size-sm); border-right: 1px solid var(--we-border); white-space: nowrap; }
.c-input-group .c-input { border: 0; border-radius: 0; box-shadow: none; min-width: 0; }
.c-search { position: relative; min-width: 200px; flex: 1 1 260px; max-width: 380px; }
.c-search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--we-text-secondary); pointer-events: none; }
.c-search .c-input { padding-left: 36px; }
.c-error { color: var(--we-error); margin: 0; font-size: var(--we-font-size-sm); }
.c-ok { color: var(--we-success-text); margin: 0; font-size: var(--we-font-size-sm); }

/* Alerts: a tinted box with a dark foreground; the text says what it is, so it never relies on colour. */
.c-alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--we-radius-md); border: 1px solid var(--we-border);
  background: var(--we-surface-muted); color: var(--we-text-body); font-size: var(--we-font-size-sm); }
.c-alert[data-tone="success"] { background: var(--we-success-soft); color: var(--we-success-text); border-color: color-mix(in srgb, var(--we-success) 30%, transparent); }
.c-alert[data-tone="warning"] { background: var(--we-warning-soft); color: var(--we-warning-text); border-color: color-mix(in srgb, var(--we-warning) 30%, transparent); }
.c-alert[data-tone="danger"] { background: var(--we-error-soft); color: var(--we-error-text); border-color: color-mix(in srgb, var(--we-error) 30%, transparent); }
.c-alert[data-tone="info"] { background: var(--we-info-soft); color: var(--we-info-text); border-color: color-mix(in srgb, var(--we-info) 30%, transparent); }

/* Cards and grids ------------------------------------------------------------- */
.c-card { background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); padding: 20px; box-shadow: var(--we-shadow-sm); }
.c-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.c-card-head h2, .c-card-head h3 { font-size: var(--we-font-size-md); margin: 0; }
.c-card-flush { padding: 0; overflow: hidden; }
.c-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.c-grid-2 { display: grid; gap: 16px; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
.c-grid-even { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 959px) { .c-grid-2, .c-grid-even { grid-template-columns: minmax(0, 1fr); } }
.c-stats { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.c-stat { display: grid; gap: 6px; }
.c-stat-label { display: flex; align-items: center; gap: 8px; color: var(--we-text-secondary); font-size: var(--we-font-size-sm); font-weight: var(--we-font-weight-medium); }
.c-stat-value { font-size: var(--we-font-size-xl); font-weight: var(--we-font-weight-semibold); letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--we-text-primary); }
.c-stat-foot { font-size: var(--we-font-size-xs); color: var(--we-text-secondary); }
.c-icon-tile { width: 36px; height: 36px; border-radius: var(--we-radius-md); display: grid; place-items: center; flex: none;
  background: var(--we-surface-muted); color: var(--we-text-primary); border: 1px solid var(--we-border); }
.c-icon-tile-lg { width: 52px; height: 52px; border-radius: var(--we-radius-lg); }
.c-hero { position: relative; overflow: hidden; border-radius: var(--we-radius-lg); padding: 24px; color: var(--we-on-primary); background: var(--we-primary); }
.c-hero::before { content: ""; position: absolute; inset: auto -90px -150px auto; width: 340px; height: 340px; border-radius: 50%;
  border: 40px solid var(--we-accent); opacity: .16; }
.c-hero > * { position: relative; }
.c-hero h2 { margin: 0 0 6px; font-size: 22px; color: inherit; }
.c-hero p { margin: 0; color: color-mix(in srgb, var(--we-on-primary) 80%, transparent); max-width: 60ch; }
.c-hero a:not(.c-btn) { color: var(--we-accent); }
.c-feature-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.c-feature-list li { display: flex; gap: 10px; align-items: flex-start; font-size: var(--we-font-size-base); }
.c-feature-list svg { flex: none; color: var(--we-success); margin-top: 2px; }
.c-checklist { list-style: none; margin: 0; padding: 0; display: grid; }
.c-checklist li { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--we-border); }
.c-checklist li:first-child { border-top: 0; }
.c-check { width: 24px; height: 24px; border-radius: 50%; flex: none; display: grid; place-items: center; border: 2px solid var(--we-border-strong); color: transparent; }
.c-check[data-done="true"] { border-color: transparent; background: var(--we-accent); color: var(--we-on-accent); }
.c-checklist strong, .c-checklist .c-cell-title { display: block; font-size: var(--we-font-size-base); }
.c-checklist span { color: var(--we-text-secondary); font-size: var(--we-font-size-sm); }
.c-checklist .c-btn { margin-left: auto; }
.c-progress { height: 8px; border-radius: var(--we-radius-pill); background: var(--we-surface-muted); overflow: hidden; }
.c-progress > i { display: block; height: 100%; background: var(--we-accent); border-radius: inherit; }

/* Tables ---------------------------------------------------------------------- */
.c-table-wrap { position: relative; overflow-x: auto; border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); background: var(--we-surface); box-shadow: var(--we-shadow-sm); }
.c-table { width: 100%; border-collapse: collapse; font-size: var(--we-font-size-base); }
.c-table th { text-align: left; font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-semibold); color: var(--we-text-secondary); background: var(--we-background);
  padding: 10px 16px; border-bottom: 1px solid var(--we-border); white-space: nowrap; }
.c-table td { padding: 12px 16px; border-bottom: 1px solid var(--we-border); vertical-align: middle; }
.c-table tr:last-child td { border-bottom: 0; }
.c-table tbody tr { transition: background-color var(--we-motion-fast) var(--we-motion-ease); }
.c-table tbody tr:hover { background: var(--we-background); }
.c-num, .c-table th.c-num { text-align: right; font-variant-numeric: tabular-nums; }
.c-cell-title { font-weight: var(--we-font-weight-semibold); color: var(--we-text-primary); text-decoration: none; }
a.c-cell-title:hover { text-decoration: underline; }
.c-cell-sub { display: block; color: var(--we-text-secondary); font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-regular); }
.c-mono { font-family: var(--we-font-mono); font-size: var(--we-font-size-xs); }
@media (max-width: 720px) {
  .c-table-stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .c-table-stack, .c-table-stack tbody, .c-table-stack tr, .c-table-stack td { display: block; width: 100%; }
  .c-table-stack tr { padding: 8px 0; border-bottom: 1px solid var(--we-border); }
  .c-table-stack td { border: 0; padding: 4px 16px; text-align: left; }
  .c-table-stack td[data-label]::before { content: attr(data-label) ": "; color: var(--we-text-secondary); font-size: var(--we-font-size-xs); }
}

/* Badges: pale background, dark foreground, and a dot, so status never depends on colour alone. */
.c-badge { display: inline-flex; align-items: center; gap: 6px; font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-medium); padding: 2px 8px; border-radius: var(--we-radius-pill);
  background: var(--we-surface-muted); color: var(--we-text-body); border: 1px solid var(--we-border); white-space: nowrap; line-height: 1.5; }
.c-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--we-text-secondary); }
.c-badge[data-tone="success"] { color: var(--we-success-text); border-color: transparent; background: var(--we-success-soft); }
.c-badge[data-tone="success"]::before { background: var(--we-success); }
.c-badge[data-tone="warning"] { color: var(--we-warning-text); border-color: transparent; background: var(--we-warning-soft); }
.c-badge[data-tone="warning"]::before { background: var(--we-warning); }
.c-badge[data-tone="danger"] { color: var(--we-error-text); border-color: transparent; background: var(--we-error-soft); }
.c-badge[data-tone="danger"]::before { background: var(--we-error); }
.c-badge[data-tone="info"] { color: var(--we-info-text); border-color: transparent; background: var(--we-info-soft); }
.c-badge[data-tone="info"]::before { background: var(--we-info); }
.c-badge[data-tone="brand"] { color: var(--we-on-primary); border-color: transparent; background: var(--we-primary); }
.c-badge[data-tone="brand"]::before { background: var(--we-accent); }
.c-badge[data-tone="ai"] { color: var(--we-ai-text); border-color: transparent; background: var(--we-ai-soft); }
.c-badge[data-tone="ai"]::before { background: var(--we-ai); }

/* Menus and popovers (details/summary) -------------------------------------------- */
.c-menu { position: relative; display: inline-block; }
.c-menu > summary { list-style: none; }
.c-menu > summary::-webkit-details-marker { display: none; }
.c-menu-list { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; min-width: 220px; display: grid; padding: 6px;
  background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); box-shadow: var(--we-shadow-lg); }
.c-menu-list a, .c-menu-list button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--we-radius-md);
  cursor: pointer; font-size: var(--we-font-size-base); color: var(--we-text-primary); }
.c-menu-list a svg, .c-menu-list button svg { color: var(--we-text-secondary); flex: none; }
.c-menu-list a:hover, .c-menu-list button:hover { background: var(--we-surface-muted); }
.c-menu-list a:focus-visible, .c-menu-list button:focus-visible { background: var(--we-surface-muted); outline: 2px solid var(--we-focus); outline-offset: -2px; }
.c-menu-list hr { border: 0; border-top: 1px solid var(--we-border); margin: 4px 0; }
.c-menu-note { padding: 6px 10px; font-size: var(--we-font-size-xs); color: var(--we-text-secondary); }
.c-menu-title { padding: 6px 10px 4px; font-size: var(--we-font-size-sm); font-weight: var(--we-font-weight-semibold); color: var(--we-text-primary); }

/* Segmented control --------------------------------------------------------------- */
.c-segmented { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--we-radius-md); background: var(--we-surface-muted); border: 1px solid var(--we-border); }
.c-segmented button { font: inherit; font-size: var(--we-font-size-sm); padding: 5px 12px; border: 0; border-radius: var(--we-radius-sm); background: transparent; color: var(--we-text-body); cursor: pointer; transition: var(--c-transition); }
.c-segmented button:hover { color: var(--we-text-primary); }
.c-segmented button[aria-pressed="true"] { background: var(--we-surface); color: var(--we-text-primary); font-weight: var(--we-font-weight-semibold); box-shadow: var(--we-shadow-sm); }

/* Detail pages: main column and a sidebar of cards -------------------------------------- */
.c-detail { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) 320px; align-items: start; }
.c-detail-main, .c-detail-side { display: grid; gap: 16px; min-width: 0; }
@media (max-width: 1099px) { .c-detail { grid-template-columns: minmax(0, 1fr); } }

/* A titled group of fields inside a form, such as one rule in a logic editor. */
.c-fieldset { display: grid; gap: 10px; min-width: 0; margin: 12px 0; padding: 10px 14px 14px; border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); }
.c-fieldset > legend { padding: 0 6px; font-size: var(--we-font-size-sm); font-weight: var(--we-font-weight-semibold); color: var(--we-text-primary); }

.c-back { display: inline-flex; align-items: center; gap: 6px; font-size: var(--we-font-size-sm); font-weight: var(--we-font-weight-medium); color: var(--we-text-secondary); text-decoration: none; margin-bottom: 8px; }
.c-back:hover { color: var(--we-text-primary); }
.c-savebar { position: sticky; bottom: 0; z-index: 15; margin: 24px -24px -48px; padding: 12px 24px; display: flex; align-items: center; justify-content: flex-end; gap: 12px;
  background: color-mix(in srgb, var(--we-surface) 94%, transparent); backdrop-filter: blur(6px); border-top: 1px solid var(--we-border); }
.c-savebar .c-status { margin-right: auto; }
@media (max-width: 959px) { .c-savebar { margin: 24px -16px -40px; padding: 12px 16px; } }

/* Checkboxes, radios and choice rows ---------------------------------------------------------- */
.c-check-input { width: 16px; height: 16px; accent-color: var(--we-primary); flex: none; margin: 0; cursor: pointer; }
.c-radio-row { display: grid; gap: 8px; }
.c-radio-card { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); cursor: pointer; background: var(--we-surface); transition: var(--c-transition); }
.c-radio-card:hover { border-color: var(--we-border-strong); }
.c-radio-card:has(input:checked) { border-color: var(--we-focus); box-shadow: var(--c-ring); }
.c-radio-card strong { display: block; font-size: var(--we-font-size-base); color: var(--we-text-primary); }
.c-radio-card span { color: var(--we-text-secondary); font-size: var(--we-font-size-sm); }
.c-inline-check { display: inline-flex; align-items: center; gap: 8px; font-size: var(--we-font-size-base); cursor: pointer; }

/* Tag input --------------------------------------------------------------------------------------- */
.c-tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 5px 8px; min-height: var(--we-size-control); border: 1px solid var(--we-border-input); border-radius: var(--we-radius-md); background: var(--we-surface); transition: var(--c-transition); }
.c-tags:focus-within { border-color: var(--we-focus); box-shadow: var(--c-ring); }
.c-tags input { border: 0; outline: 0; flex: 1 1 120px; min-width: 80px; font: inherit; font-size: var(--we-font-size-base); padding: 2px 4px; background: transparent; color: var(--we-text-primary); }
.c-tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 9px; border-radius: var(--we-radius-sm); font-size: var(--we-font-size-sm); font-weight: var(--we-font-weight-medium);
  background: var(--we-surface-muted); color: var(--we-text-primary); border: 1px solid var(--we-border); }
.c-tag button { all: unset; cursor: pointer; display: grid; place-items: center; width: 18px; height: 18px; border-radius: var(--we-radius-sm); color: var(--we-text-secondary); }
.c-tag button:hover, .c-tag button:focus-visible { background: var(--we-border); color: var(--we-text-primary); }


/* Dialogs and drawers (native <dialog>) ---------------------------------------------------------------- */
.c-dialog { border: 1px solid var(--we-border); padding: 0; border-radius: var(--we-radius-xl); width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px); color: var(--we-text-body);
  background: var(--we-surface); box-shadow: var(--we-shadow-lg); }
.c-dialog-wide { width: min(920px, calc(100vw - 32px)); }
.c-dialog::backdrop { background: var(--we-overlay); }
.c-dialog[open] { display: flex; flex-direction: column; }
.c-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px 12px; border-bottom: 1px solid var(--we-border); }
.c-dialog-head h2 { margin: 0; font-size: var(--we-font-size-md); }
.c-dialog-body { padding: 16px 20px; overflow-y: auto; display: grid; gap: 16px; align-content: start; }
.c-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--we-border); }
.c-drawer { margin: 0 0 0 auto; height: 100vh; max-height: 100vh; border-radius: 0; border-width: 0 0 0 1px; width: min(440px, 100vw); }
.c-pager { display: flex; justify-content: center; margin-top: 16px; }

/* Assistant: a floating button in the bottom-right corner and the chat window above it ------------ */
.c-fab { position: fixed; z-index: 46; right: calc(24px + env(safe-area-inset-right)); bottom: calc(24px + env(safe-area-inset-bottom));
  width: 56px; height: 56px; border-radius: 50%; border: 0; display: grid; place-items: center; cursor: pointer;
  background: var(--we-primary); color: var(--we-accent); box-shadow: var(--we-shadow-lg);
  transition: background-color var(--we-motion-fast) var(--we-motion-ease), transform var(--we-motion-fast) var(--we-motion-ease); }
.c-fab:hover { background: var(--we-primary-hover); transform: translateY(-1px); }
.c-fab:focus-visible { outline: 3px solid var(--we-accent); outline-offset: 3px; }
.c-fab[data-open="true"] { color: var(--we-on-primary); }
.c-fab:not([data-open="true"]) { box-shadow: var(--we-shadow-lg), 0 0 0 3px color-mix(in srgb, var(--we-accent) 50%, transparent); }
/* Above a sticky save bar, so it never covers Save. */
.c-app:has(.c-savebar) .c-fab { bottom: calc(84px + env(safe-area-inset-bottom)); }
.c-chatbox { position: fixed; z-index: 45; right: calc(24px + env(safe-area-inset-right)); bottom: calc(92px + env(safe-area-inset-bottom));
  width: min(400px, calc(100vw - 48px)); height: min(640px, calc(100dvh - 124px)); display: flex; flex-direction: column; overflow: hidden;
  background: var(--we-surface); color: var(--we-text-body); border: 2px solid var(--we-primary); border-radius: var(--we-radius-xl); box-shadow: var(--we-shadow-lg), 0 0 0 4px color-mix(in srgb, var(--we-accent) 18%, transparent);
  transform-origin: bottom right; animation: c-chatbox-in var(--we-motion-base) var(--we-motion-ease); }
.c-app:has(.c-savebar) .c-chatbox { bottom: calc(152px + env(safe-area-inset-bottom)); height: min(640px, calc(100dvh - 184px)); }
@keyframes c-chatbox-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
.c-chatbox-head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--we-border); flex: none; }
.c-chatbox-head > div { flex: 1; min-width: 0; display: grid; }
.c-chatbox-head h2 { margin: 0; font-size: var(--we-font-size-md); }
.c-chatbox-head small { color: var(--we-text-secondary); font-size: var(--we-font-size-xs); }
/* The agent's avatar: the robot face on a navy disc, with a green ring. */
.c-agent { display: grid; place-items: center; flex: none; border-radius: 50%; background: var(--we-primary); box-shadow: 0 0 0 2px var(--we-surface), 0 0 0 3px color-mix(in srgb, var(--we-accent) 55%, transparent); }
.c-agent svg { display: block; }
.c-agent-sm { width: 28px; height: 28px; }
.c-agent-md { width: 36px; height: 36px; }
.c-agent-lg { width: 72px; height: 72px; box-shadow: 0 0 0 4px var(--we-surface), 0 0 0 6px color-mix(in srgb, var(--we-accent) 45%, transparent); }
.c-agent-eyes { transform-box: fill-box; transform-origin: center; animation: c-agent-blink 5s infinite; }
@keyframes c-agent-blink { 0%, 94%, 100% { transform: scaleY(1); } 96% { transform: scaleY(.15); } }
.c-msg-row { display: flex; gap: 8px; align-items: flex-start; }
.c-msg-row[data-role="user"] { justify-content: flex-end; }
.c-msg-row > .c-msg { max-width: calc(100% - 36px); }
.c-chat-hello { font-size: var(--we-font-size-md); font-weight: var(--we-font-weight-semibold); color: var(--we-text-primary); }
.c-typing { display: inline-flex; gap: 4px; padding: 12px 14px; border-radius: var(--we-radius-lg) var(--we-radius-lg) var(--we-radius-lg) var(--we-radius-sm); background: var(--we-surface-muted); }
.c-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--we-text-secondary); animation: c-typing 1.2s infinite ease-in-out; }
.c-typing i:nth-child(2) { animation-delay: .15s; }
.c-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes c-typing { 0%, 60%, 100% { opacity: .35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .c-agent-eyes, .c-typing i { animation: none; } }
/* Phones: the chat takes the whole screen; the header's close button replaces the floating one. */
@media (max-width: 640px) {
  .c-fab { right: calc(16px + env(safe-area-inset-right)); bottom: calc(16px + env(safe-area-inset-bottom)); width: 52px; height: 52px; }
  .c-app:has(.c-savebar) .c-fab { bottom: calc(76px + env(safe-area-inset-bottom)); }
  .c-chatbox, .c-app:has(.c-savebar) .c-chatbox { inset: 0; width: 100%; height: 100dvh; border: 0; border-radius: 0;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .c-fab[data-open="true"] { display: none; }
  body:has(.c-chatbox) { overflow: hidden; }
}
@media print { .c-fab, .c-chatbox { display: none; } }
/* Chat text is compact: 13px messages, 12px for chips, notes, cards and the footer. */
.c-chatbox { font-size: var(--we-font-size-sm); line-height: 1.45; }
.c-chatbox-head h2 { font-size: 15px; }
.c-chatbox .c-chat-log { padding: 14px 16px; gap: 10px; }
.c-chatbox .c-msg > p:first-of-type { padding: 7px 11px; }
.c-chatbox .c-chat-hello { font-size: 15px; }
.c-chatbox .c-chat-intro { gap: 10px; }
.c-chatbox .c-chat-suggest .c-btn { font-size: var(--we-font-size-xs); min-height: 28px; padding: 5px 10px; }
.c-chatbox .c-msg > .c-btn { font-size: var(--we-font-size-xs); min-height: 28px; }
.c-chatbox .c-msg-note, .c-chatbox .c-proposal .c-kv, .c-chatbox .c-proposal .c-hint, .c-chatbox .c-proposal .c-ok, .c-chatbox .c-proposal .c-error { font-size: var(--we-font-size-xs); }
.c-chatbox .c-proposal { padding: 10px 12px; gap: 8px; }
.c-chatbox .c-proposal strong { font-size: var(--we-font-size-sm); }
.c-chatbox .c-chat-form { padding: 10px 16px 12px; gap: 6px; }
.c-chatbox .c-chat-form .c-textarea { font-size: var(--we-font-size-sm); min-height: 0; padding: 7px 10px; }
.c-chatbox .c-chat-foot .c-hint, .c-chatbox .c-chat-foot .c-link-btn { font-size: var(--we-font-size-xs); }
.c-chatbox .c-agent-lg { width: 60px; height: 60px; }
.c-chatbox .c-agent-lg svg { width: 46px; height: 46px; }
.c-chat { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
.c-chat-log { flex: 1; overflow-y: auto; padding: 16px 20px; display: grid; gap: 12px; align-content: start; }
.c-chat-intro { display: grid; gap: 12px; justify-items: start; color: var(--we-text-body); }
.c-chat-intro p { margin: 0; }
.c-chat-suggest { display: flex; flex-wrap: wrap; gap: 8px; }
.c-chat-suggest .c-btn { white-space: normal; text-align: left; height: auto; min-height: var(--we-size-control-sm); padding: 6px 10px; }
.c-msg { display: grid; gap: 8px; justify-items: start; max-width: 92%; margin: 0; }
.c-msg > p { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
.c-msg[data-role="user"] { justify-self: end; justify-items: end; }
.c-msg[data-role="user"] > p { padding: 8px 12px; border-radius: var(--we-radius-lg) var(--we-radius-lg) var(--we-radius-sm) var(--we-radius-lg); background: var(--we-primary); color: var(--we-on-primary); }
.c-msg[data-role="assistant"] > p:first-of-type { padding: 8px 12px; border-radius: var(--we-radius-lg) var(--we-radius-lg) var(--we-radius-lg) var(--we-radius-sm); background: var(--we-surface-muted); color: var(--we-text-primary); }
.c-msg[data-error="true"] > p:first-of-type { background: var(--we-error-soft); color: var(--we-error-text); }
.c-msg-note { padding: 8px 12px; border-radius: var(--we-radius-md); background: var(--we-warning-soft); color: var(--we-warning-text); font-size: var(--we-font-size-sm); }
.c-chat-busy { color: var(--we-text-secondary); font-size: var(--we-font-size-sm); }
.c-proposal { display: grid; gap: 10px; width: 100%; padding: 12px 14px; border: 1px solid var(--we-border-strong); border-radius: var(--we-radius-lg); background: var(--we-surface); }
.c-proposal[data-danger="true"] { border-color: color-mix(in srgb, var(--we-error) 45%, var(--we-border)); }
.c-proposal strong { color: var(--we-text-primary); }
.c-proposal .c-kv { font-size: var(--we-font-size-sm); }
.c-proposal-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.c-chat-form { display: grid; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--we-border); background: var(--we-surface); }
.c-chat-form .c-textarea { resize: none; }
.c-chat-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.c-chat > .c-alert { margin: 12px 20px 16px; }


/* Charts: white surface, muted grid, text in text colours ------------------------------------------ */
.c-chart { margin: 0; position: relative; }
.c-chart-plot { position: relative; }
.c-chart svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: pan-y; }
.c-chart svg:focus-visible { outline: 2px solid var(--we-focus); outline-offset: 4px; border-radius: var(--we-radius-md); }
.c-chart-grid { stroke: var(--we-border); stroke-width: 1; vector-effect: non-scaling-stroke; }
.c-chart-axis { fill: var(--we-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.c-chart-cross { stroke: var(--we-text-secondary); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.c-chart-dot { stroke: var(--we-surface); stroke-width: 2; }
.c-chart-tip { position: absolute; top: 0; transform: translateX(-50%); pointer-events: none; display: grid; gap: 2px; padding: 6px 10px; border-radius: var(--we-radius-md);
  background: var(--we-surface); border: 1px solid var(--we-border); box-shadow: var(--we-shadow-md); font-size: var(--we-font-size-xs); white-space: nowrap; color: var(--we-text-primary); font-variant-numeric: tabular-nums; }
.c-chart-tip span { color: var(--we-text-secondary); }
.c-chart-toggle { margin-top: 6px; padding: 0; border: 0; background: none; color: var(--we-link); font: inherit; font-size: var(--we-font-size-xs); cursor: pointer; text-decoration: underline; }
.c-barlist, .c-funnel { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.c-barlist-text { display: flex; justify-content: space-between; gap: 12px; font-size: var(--we-font-size-base); margin-bottom: 4px; }
.c-barlist-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-barlist-text strong { font-variant-numeric: tabular-nums; color: var(--we-text-primary); }
.c-barlist-track { height: 8px; border-radius: 4px; background: var(--we-surface-muted); overflow: hidden; }
.c-barlist-track i { display: block; height: 100%; border-radius: 4px; }
.c-delta { font-size: var(--we-font-size-xs); color: var(--we-text-secondary); font-variant-numeric: tabular-nums; }
.c-delta[data-tone="up"]::first-letter, .c-delta[data-tone="down"]::first-letter { font-weight: 700; }
.c-delta[data-tone="up"]::first-letter { color: var(--we-success-text); }
.c-delta[data-tone="down"]::first-letter { color: var(--we-error); }
.c-range { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--we-radius-md); background: var(--we-surface-muted); border: 1px solid var(--we-border); }
.c-range button { border: 0; background: none; padding: 5px 12px; border-radius: var(--we-radius-sm); font: inherit; font-size: var(--we-font-size-sm); color: var(--we-text-body); cursor: pointer; transition: var(--c-transition); }
.c-range button:hover { color: var(--we-text-primary); }
.c-range button[aria-pressed="true"] { background: var(--we-surface); color: var(--we-text-primary); font-weight: var(--we-font-weight-semibold); box-shadow: var(--we-shadow-sm); }
.c-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: var(--we-font-size-base); }
.c-kv dt { color: var(--we-text-secondary); }
.c-kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.c-kv-strong { font-weight: var(--we-font-weight-semibold); color: var(--we-text-primary); }

/* Empty, loading and status states --------------------------------------------------- */
.c-empty { text-align: center; padding: 48px 24px; border: 1px dashed var(--we-border-strong); border-radius: var(--we-radius-lg); background: var(--we-surface); }
.c-empty .c-icon-tile { margin: 0 auto; }
.c-empty h2 { font-size: var(--we-font-size-lg); margin: 16px 0 6px; }
.c-empty p { color: var(--we-text-secondary); margin: 0 auto 20px; max-width: 52ch; }
.c-empty-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.c-status { min-height: 1.5em; margin: 0; font-size: var(--we-font-size-sm); }
.c-skeleton { height: 14px; border-radius: var(--we-radius-sm); background: linear-gradient(90deg, var(--we-surface-muted), var(--we-border), var(--we-surface-muted));
  background-size: 200% 100%; animation: c-shimmer 1.2s infinite; }
@keyframes c-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.c-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.c-muted { color: var(--we-text-secondary); }
.c-center-page { min-height: 100vh; display: grid; place-items: center; padding: 32px 16px; background: var(--we-background); }
.c-auth { width: min(100%, 440px); display: grid; gap: 24px; }
.c-auth-brand { display: flex; align-items: center; gap: 12px; justify-content: center; }
.c-auth-brand strong { font-size: 20px; letter-spacing: -.01em; color: var(--we-text-primary); }
.c-auth-brand small { display: block; font-size: var(--we-font-size-xs); font-weight: var(--we-font-weight-medium); color: var(--we-text-secondary); }
`;

/** Everything the admin's root layout puts in its one <style> tag. */
export function adminStyles(): string {
  return `${tokensCss()}\n${BASE_CSS}\n${ADMIN_CSS}`;
}
