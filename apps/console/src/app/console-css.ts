/**
 * Console component styles: the WorkEasy360 design system's shared
 * vocabulary for every page, built only on `--we-*` tokens (packages/ui).
 * Classes are prefixed `c-`. Layout: a full-height navy sidebar beside a top
 * bar and page container; on narrow screens the sidebar becomes a horizontal
 * bar under the top bar.
 */
export const CONSOLE_CSS = `
:root { --c-sidebar: var(--we-sidebar-width); --c-topbar: var(--we-topbar-height); --c-shadow: var(--we-shadow-xs); }
a { color: var(--we-link); text-underline-offset: 2px; }
h1, h2, h3, h4 { color: var(--we-text-primary); line-height: 1.3; font-weight: 600; }
h1 { font-size: var(--we-text-xl); line-height: var(--we-leading-xl); }
h2 { font-size: var(--we-text-lg); line-height: var(--we-leading-lg); }
h3 { font-size: var(--we-text-md); line-height: var(--we-leading-md); }
/* A rendered form (preview, builder canvas) takes its colours from its own theme. */
.we-surface :is(h1, h2, h3, h4), .b-canvas :is(h1, h2, h3, h4) { color: inherit; }
input[type="checkbox"], input[type="radio"], input[type="range"], progress { accent-color: var(--we-primary); }
::placeholder { color: var(--we-text-secondary); opacity: 1; }
::selection { background: var(--we-accent-soft); color: var(--we-text-primary); }
code, kbd, pre { font-family: var(--we-font-mono); font-size: .92em; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }

/* App shell */
.c-app { display: grid; grid-template-columns: var(--c-sidebar) minmax(0, 1fr); grid-template-rows: var(--c-topbar) 1fr;
  grid-template-areas: "side top" "side main"; min-height: 100vh; }
.c-topbar { grid-area: top; display: flex; align-items: center; gap: var(--we-space-4); padding: 0 var(--we-space-6); height: var(--c-topbar);
  border-bottom: 1px solid var(--we-border); background: var(--we-surface); position: sticky; top: 0; z-index: 20; }
.c-brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; color: var(--we-text-primary); text-decoration: none; white-space: nowrap; }
.c-brand-mark { flex: none; width: 28px; height: 28px; border-radius: var(--we-radius-md); background: var(--we-accent); color: var(--we-on-accent);
  display: grid; place-items: center; font-size: 14px; font-weight: 700; letter-spacing: -.02em; }
.c-brand-name { display: grid; line-height: 1.15; }
.c-brand-name small { font-size: var(--we-text-xs); font-weight: 500; color: var(--we-text-secondary); }
.c-topbar .c-brand { display: none; }
.c-org { color: var(--we-text-primary); font-weight: 600; font-size: var(--we-text-base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-topbar-end { margin-left: auto; display: flex; align-items: center; gap: var(--we-space-2); }
.c-avatar { flex: none; width: 28px; height: 28px; border-radius: 50%; display: inline-grid; place-items: center; font-size: var(--we-text-xs); font-weight: 600;
  background: var(--we-primary); color: var(--we-on-primary); }
.c-sidebar { grid-area: side; display: flex; flex-direction: column; background: var(--we-sidebar-bg); color: var(--we-sidebar-text);
  border-right: 1px solid var(--we-sidebar-border); position: sticky; top: 0; height: 100vh; overflow-y: auto; --we-focus: var(--we-sidebar-indicator); }
.c-sidebar .c-brand { height: var(--c-topbar); padding: 0 var(--we-space-4); color: var(--we-sidebar-active-text); border-bottom: 1px solid var(--we-sidebar-border); flex: none; }
.c-sidebar .c-brand-name small { color: var(--we-sidebar-label); }
.c-sidebar-body { padding: var(--we-space-3); }
.c-nav { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.c-nav-label { font-size: var(--we-text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--we-sidebar-label); margin: var(--we-space-2) var(--we-space-3) var(--we-space-2); }
.c-nav a { position: relative; display: flex; align-items: center; gap: 10px; min-height: var(--we-nav-item-height); padding: 0 var(--we-space-3); border-radius: var(--we-radius-md);
  color: var(--we-sidebar-text); text-decoration: none; font-size: var(--we-text-base); font-weight: 500;
  transition: background-color var(--we-duration-fast) var(--we-ease), color var(--we-duration-fast) var(--we-ease); }
.c-nav a:hover { background: var(--we-sidebar-hover); color: var(--we-sidebar-active-text); }
.c-nav a[aria-current="page"] { background: var(--we-sidebar-active); color: var(--we-sidebar-active-text); font-weight: 600; }
.c-nav a[aria-current="page"]::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--we-sidebar-indicator); }
.c-nav a[aria-current="page"] svg { color: var(--we-sidebar-indicator); }
.c-nav svg { flex: none; width: var(--we-icon-size); height: var(--we-icon-size); }
.c-main { grid-area: main; min-width: 0; }
.c-app[data-focus="true"] { grid-template-columns: minmax(0, 1fr); grid-template-areas: "top" "main"; }
.c-app[data-focus="true"] .c-topbar .c-brand { display: flex; }
.c-app[data-focus="true"] .c-topbar { padding: 0 var(--we-space-4); }
.c-main:focus { outline: none; }
.c-skip { position: absolute; left: 8px; top: -48px; z-index: 100; padding: 8px 12px; border-radius: var(--we-radius-md);
  background: var(--we-primary); color: var(--we-on-primary); font-weight: 600; }
.c-skip:focus { top: 8px; }
.c-page { max-width: var(--we-content-max); margin: 0 auto; padding: var(--we-space-8) var(--we-space-6); }
.c-page-wide { max-width: none; }
.c-page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--we-space-3) var(--we-space-4); margin-bottom: var(--we-space-6); }
.c-page-head h1 { margin: 0; }
.c-subtitle { color: var(--we-text-secondary); margin: var(--we-space-1) 0 0; }
.c-toolbar { display: flex; flex-wrap: wrap; gap: var(--we-space-2); align-items: center; }
@media (max-width: 899px) {
  .c-app { grid-template-columns: minmax(0, 1fr); grid-template-rows: var(--c-topbar) auto 1fr; grid-template-areas: "top" "side" "main"; }
  .c-topbar { gap: var(--we-space-2); padding: 0 var(--we-space-3); }
  .c-topbar .c-brand { display: flex; }
  .c-topbar .c-brand-name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .c-sidebar { position: static; height: auto; min-width: 0; border-right: 0; border-bottom: 1px solid var(--we-sidebar-border); }
  .c-sidebar .c-brand { display: none; }
  .c-sidebar-body { padding: var(--we-space-2) var(--we-space-3); }
  .c-org { min-width: 0; flex: 1; }
  .c-topbar-end summary { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-nav { display: flex; overflow-x: auto; gap: var(--we-space-1); }
  .c-nav-label { display: none; }
  .c-nav a { white-space: nowrap; }
  .c-nav a[aria-current="page"]::before { left: 10px; right: 10px; top: auto; bottom: 0; width: auto; height: 3px; border-radius: 3px 3px 0 0; }
  .c-page { padding: var(--we-space-6) var(--we-space-4); }
}

/* Form header and tabs */
.c-formbar { border-bottom: 1px solid var(--we-border); background: var(--we-surface); padding: var(--we-space-4) var(--we-space-6) 0; }
.c-formbar-top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--we-space-2) var(--we-space-3); }
.c-formbar h1 { font-size: var(--we-text-lg); line-height: var(--we-leading-lg); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.c-tabs { display: flex; gap: var(--we-space-1); overflow-x: auto; margin-top: var(--we-space-2); }
.c-tabs a { padding: 10px var(--we-space-3); color: var(--we-text-secondary); text-decoration: none; border-bottom: 2px solid transparent; white-space: nowrap;
  font-weight: 500; transition: color var(--we-duration-fast) var(--we-ease), border-color var(--we-duration-fast) var(--we-ease); }
.c-tabs a:hover { color: var(--we-text-primary); border-bottom-color: var(--we-border); }
.c-tabs a[aria-current="page"] { color: var(--we-primary); font-weight: 600; border-bottom-color: var(--we-accent); }
@media (max-width: 899px) { .c-formbar { padding: var(--we-space-3) var(--we-space-4) 0; } }

/* Buttons: primary (green), secondary (default), danger, ghost */
.c-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: var(--we-text-base); font-weight: 500;
  min-height: var(--we-control-height); padding: 0 14px; border-radius: var(--we-radius-md); border: 1px solid var(--we-border); background: var(--we-surface);
  color: var(--we-text-primary); cursor: pointer; text-decoration: none; line-height: 1.2; box-shadow: var(--we-shadow-xs);
  transition: background-color var(--we-duration-fast) var(--we-ease), border-color var(--we-duration-fast) var(--we-ease), color var(--we-duration-fast) var(--we-ease); }
.c-btn:hover { background: var(--we-surface-hover); border-color: var(--we-border-strong); }
.c-btn:disabled, .c-btn[aria-disabled="true"] { opacity: .5; cursor: not-allowed; box-shadow: none; }
.c-btn:disabled:hover, .c-btn[aria-disabled="true"]:hover { background: var(--we-surface); border-color: var(--we-border); }
.c-btn-primary { background: var(--we-accent); border-color: var(--we-accent); color: var(--we-on-accent); font-weight: 600; }
.c-btn-primary:hover { background: var(--we-accent-hover); border-color: var(--we-accent-hover); }
.c-btn-primary:disabled:hover, .c-btn-primary[aria-disabled="true"]:hover { background: var(--we-accent); border-color: var(--we-accent); }
.c-btn-danger { color: var(--we-error-fg); border-color: color-mix(in srgb, var(--we-error) 35%, var(--we-border)); }
.c-btn-danger:hover { background: var(--we-error-bg); border-color: var(--we-error); }
.c-btn-ghost { border-color: transparent; background: transparent; box-shadow: none; }
.c-btn-ghost:hover { border-color: transparent; }
.c-btn-sm { min-height: var(--we-control-height-sm); padding: 0 10px; font-size: var(--we-text-sm); }
.c-link-btn { font: inherit; padding: 0; border: 0; background: none; color: var(--we-link); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }

/* Inputs */
.c-field { display: grid; gap: 6px; }
.c-label { font-weight: 500; font-size: var(--we-text-sm); color: var(--we-text-primary); }
.c-hint { color: var(--we-text-secondary); font-size: var(--we-text-sm); margin: 0; }
.c-input, .c-select, .c-textarea { font: inherit; font-size: var(--we-text-base); min-height: var(--we-control-height); padding: 7px 10px; border-radius: var(--we-radius-md);
  border: 1px solid var(--we-border-strong); background: var(--we-surface); color: var(--we-text-primary); width: 100%;
  transition: border-color var(--we-duration-fast) var(--we-ease), box-shadow var(--we-duration-fast) var(--we-ease); }
.c-input:hover, .c-select:hover, .c-textarea:hover { border-color: var(--we-text-secondary); }
.c-input:focus-visible, .c-select:focus-visible, .c-textarea:focus-visible { outline: none; border-color: var(--we-focus);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--we-focus) 25%, transparent); }
.c-input:disabled, .c-select:disabled, .c-textarea:disabled { background: var(--we-surface-muted); color: var(--we-text-secondary); cursor: not-allowed; }
.c-input[aria-invalid="true"], .c-select[aria-invalid="true"], .c-textarea[aria-invalid="true"] { border-color: var(--we-error); }
.c-search { position: relative; min-width: 220px; flex: 1 1 260px; max-width: 360px; }
.c-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--we-text-secondary); pointer-events: none; }
.c-search .c-input { padding-left: 34px; }
.c-error { color: var(--we-error-fg); margin: 0; font-size: var(--we-text-sm); }

/* Alerts: pale background, dark foreground, and an edge so tone isn't colour alone */
.c-alert { display: flex; gap: var(--we-space-2); align-items: flex-start; padding: var(--we-space-3) var(--we-space-4); border-radius: var(--we-radius-md);
  border: 1px solid var(--we-border); border-left-width: 4px; background: var(--we-surface); color: var(--we-text-body); margin: 0 0 var(--we-space-4); }
.c-alert[data-tone="info"] { background: var(--we-info-bg); color: var(--we-info-fg); border-color: color-mix(in srgb, var(--we-info) 30%, transparent); border-left-color: var(--we-info); }
.c-alert[data-tone="success"] { background: var(--we-success-bg); color: var(--we-success-fg); border-color: color-mix(in srgb, var(--we-success) 30%, transparent); border-left-color: var(--we-success); }
.c-alert[data-tone="warning"] { background: var(--we-warning-bg); color: var(--we-warning-fg); border-color: color-mix(in srgb, var(--we-warning) 30%, transparent); border-left-color: var(--we-warning); }
.c-alert[data-tone="danger"] { background: var(--we-error-bg); color: var(--we-error-fg); border-color: color-mix(in srgb, var(--we-error) 30%, transparent); border-left-color: var(--we-error); }
.c-alert a { color: inherit; font-weight: 600; }

/* Cards, grids and panels */
.c-card { background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); padding: var(--we-space-5); box-shadow: var(--c-shadow); }
.c-grid { display: grid; gap: var(--we-space-4); grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.c-choice { text-align: left; display: grid; gap: var(--we-space-2); align-content: start; cursor: pointer; font: inherit; color: inherit;
  transition: border-color var(--we-duration-fast) var(--we-ease), box-shadow var(--we-duration-fast) var(--we-ease); }
.c-choice:hover { border-color: var(--we-border-strong); box-shadow: var(--we-shadow-sm); }
.c-choice[aria-pressed="true"], .c-choice[aria-checked="true"] { border-color: var(--we-primary); box-shadow: 0 0 0 1px var(--we-primary); }
.c-choice h2, .c-choice h3 { margin: 0; font-size: var(--we-text-md); }
.c-choice p { margin: 0; color: var(--we-text-secondary); font-size: var(--we-text-sm); }
.c-icon-tile { width: 40px; height: 40px; border-radius: var(--we-radius-md); display: grid; place-items: center; background: var(--we-accent-soft); color: var(--we-accent-strong); }

/* Tables */
.c-table-wrap { position: relative; overflow-x: auto; border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); background: var(--we-surface); box-shadow: var(--c-shadow); }
.c-table { width: 100%; border-collapse: collapse; font-size: var(--we-text-base); }
.c-table th { text-align: left; font-size: var(--we-text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--we-text-secondary);
  background: var(--we-background); padding: 10px var(--we-space-4); border-bottom: 1px solid var(--we-border); white-space: nowrap; }
.c-table td { padding: var(--we-space-3) var(--we-space-4); border-bottom: 1px solid var(--we-border); vertical-align: middle; color: var(--we-text-body); }
.c-table tr:last-child td { border-bottom: 0; }
.c-table tbody tr { transition: background-color var(--we-duration-fast) var(--we-ease); }
.c-table tbody tr:hover { background: var(--we-background); }
.c-num, .c-table th.c-num { text-align: right; font-variant-numeric: tabular-nums; }
.c-cell-title { font-weight: 600; color: var(--we-text-primary); text-decoration: none; }
a.c-cell-title:hover { text-decoration: underline; }
.c-cell-sub { display: block; color: var(--we-text-secondary); font-size: var(--we-text-sm); font-weight: 400; }
@media (max-width: 720px) {
  .c-table-stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .c-table-stack, .c-table-stack tbody, .c-table-stack tr, .c-table-stack td { display: block; width: 100%; }
  .c-table-stack tr { padding: var(--we-space-2) 0; border-bottom: 1px solid var(--we-border); }
  .c-table-stack td { border: 0; padding: var(--we-space-1) var(--we-space-4); text-align: left; }
  .c-table-stack td[data-label]::before { content: attr(data-label) ": "; color: var(--we-text-secondary); font-size: var(--we-text-sm); }
}

/* Badges: dot + label, so status never depends on colour alone */
.c-badge { display: inline-flex; align-items: center; gap: 6px; font-size: var(--we-text-xs); font-weight: 500; line-height: 18px; padding: 1px 8px; border-radius: var(--we-radius-full);
  background: var(--we-surface-muted); color: var(--we-text-body); border: 1px solid transparent; white-space: nowrap; }
.c-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.c-badge[data-tone="live"], .c-badge[data-tone="success"] { color: var(--we-success-fg); background: var(--we-success-bg); }
.c-badge[data-tone="closed"], .c-badge[data-tone="warning"] { color: var(--we-warning-fg); background: var(--we-warning-bg); }
.c-badge[data-tone="danger"] { color: var(--we-error-fg); background: var(--we-error-bg); }
.c-badge[data-tone="info"] { color: var(--we-info-fg); background: var(--we-info-bg); }
.c-badge[data-tone="ai"] { color: var(--we-ai-fg); background: var(--we-ai-bg); }

/* Menus (details/summary) */
.c-menu { position: relative; display: inline-block; }
.c-menu > summary { list-style: none; }
.c-menu > summary::-webkit-details-marker { display: none; }
.c-menu-list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 200px; display: grid; padding: var(--we-space-1);
  background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); box-shadow: var(--we-shadow-lg); }
.c-menu-list a, .c-menu-list button { all: unset; box-sizing: border-box; display: block; padding: var(--we-space-2) 10px; border-radius: var(--we-radius-sm);
  cursor: pointer; font-size: var(--we-text-base); color: var(--we-text-body); }
.c-menu-list a:hover, .c-menu-list button:hover, .c-menu-list a:focus-visible, .c-menu-list button:focus-visible { background: var(--we-surface-hover); color: var(--we-text-primary); }
.c-menu-list a:focus-visible, .c-menu-list button:focus-visible { outline: 2px solid var(--we-focus); outline-offset: -2px; }
.c-menu-list button:disabled { opacity: .5; cursor: not-allowed; }
.c-menu-list .c-danger { color: var(--we-error-fg); }
.c-menu-list hr { border: 0; border-top: 1px solid var(--we-border); margin: var(--we-space-1) 0; }
.c-menu-meta { display: block; padding: 6px 10px; font-size: var(--we-text-sm); color: var(--we-text-secondary); }

/* Segmented control */
.c-segmented { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--we-border); border-radius: var(--we-radius-md); background: var(--we-surface-muted); }
.c-segmented button { font: inherit; font-size: var(--we-text-sm); font-weight: 500; min-height: 28px; padding: 0 12px; border: 0; border-radius: var(--we-radius-sm);
  background: transparent; color: var(--we-text-body); cursor: pointer; transition: background-color var(--we-duration-fast) var(--we-ease); }
.c-segmented button:hover { color: var(--we-text-primary); }
.c-segmented button[aria-pressed="true"] { background: var(--we-surface); color: var(--we-text-primary); font-weight: 600; box-shadow: var(--we-shadow-sm); }

/* Empty and status states */
.c-empty { text-align: center; padding: var(--we-space-12) var(--we-space-6); border: 1px dashed var(--we-border-strong); border-radius: var(--we-radius-lg); background: var(--we-surface); }
.c-empty h2 { font-size: var(--we-text-lg); margin: var(--we-space-3) 0 var(--we-space-1); }
.c-empty p { color: var(--we-text-secondary); margin: 0 0 var(--we-space-4); }
.c-status { min-height: 1.5em; margin: 0 0 var(--we-space-3); font-size: var(--we-text-sm); }
.c-skeleton { height: 14px; border-radius: var(--we-radius-sm); background: linear-gradient(90deg, var(--we-surface-muted), var(--we-border), var(--we-surface-muted));
  background-size: 200% 100%; animation: c-shimmer 1.2s infinite; }
@keyframes c-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.c-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Metrics and charts */
.c-stats { display: grid; gap: var(--we-space-4); grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: var(--we-space-6); }
.c-stat { background: var(--we-surface); border: 1px solid var(--we-border); border-radius: var(--we-radius-lg); padding: var(--we-space-4); box-shadow: var(--c-shadow); }
.c-stat h2 { font-size: var(--we-text-sm); font-weight: 500; color: var(--we-text-secondary); margin: 0; }
.c-stat .c-stat-value { font-size: var(--we-text-xl); line-height: var(--we-leading-xl); font-weight: 600; color: var(--we-text-primary); margin: var(--we-space-1) 0; font-variant-numeric: tabular-nums; }
.c-stat p:not(.c-stat-value) { font-size: var(--we-text-sm); margin: 0; color: var(--we-text-secondary); }
`;
