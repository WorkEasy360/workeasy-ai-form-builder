/**
 * Console component styles (docs/01 §3): one shared vocabulary for every
 * page, built on the design tokens. Classes are prefixed `c-`. Layout: a
 * sidebar and top bar around a page container; on narrow screens the
 * sidebar becomes a horizontal bar.
 */
export const CONSOLE_CSS = `
:root { --c-sidebar: 232px; --c-topbar: 56px; --c-shadow: 0 1px 2px rgb(16 24 40 / .06), 0 1px 3px rgb(16 24 40 / .1);
  --we-color-success: #15803D; --we-color-warning: #B45309; }
@media (prefers-color-scheme: dark) { :root { --c-shadow: 0 1px 3px rgb(0 0 0 / .5); --we-color-success: #4ADE80; --we-color-warning: #FBBF24; } }
a { color: var(--we-color-accent); }
h1, h2, h3 { line-height: 1.25; }

/* App shell */
.c-app { display: grid; grid-template-columns: var(--c-sidebar) minmax(0, 1fr); grid-template-rows: var(--c-topbar) 1fr; min-height: 100vh; }
.c-topbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--we-color-border);
  background: var(--we-color-background); position: sticky; top: 0; z-index: 20; }
.c-brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--we-color-text); text-decoration: none; white-space: nowrap; }
.c-brand-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--we-color-accent); color: var(--we-color-accentText);
  display: grid; place-items: center; font-size: 14px; font-weight: 800; }
.c-org { color: var(--we-color-textMuted); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-topbar-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.c-sidebar { border-right: 1px solid var(--we-color-border); background: var(--we-color-surface); padding: 16px 12px; position: sticky;
  top: var(--c-topbar); height: calc(100vh - var(--c-topbar)); overflow-y: auto; }
.c-nav { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.c-nav-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--we-color-textMuted); margin: 16px 8px 6px; }
.c-nav a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--we-radius-md); color: var(--we-color-text);
  text-decoration: none; font-size: 15px; }
.c-nav a:hover { background: color-mix(in srgb, var(--we-color-accent) 8%, transparent); }
.c-nav a[aria-current="page"] { background: color-mix(in srgb, var(--we-color-accent) 14%, transparent); color: var(--we-color-accent); font-weight: 600; }
.c-nav svg { flex: none; }
.c-main { min-width: 0; }
.c-page { max-width: 1120px; margin: 0 auto; padding: 24px; }
.c-page-wide { max-width: none; }
.c-page-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; margin-bottom: 20px; }
.c-page-head h1 { font-size: 26px; margin: 0; }
.c-subtitle { color: var(--we-color-textMuted); margin: 4px 0 0; }
.c-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
@media (max-width: 899px) {
  .c-app { grid-template-columns: minmax(0, 1fr); grid-template-rows: var(--c-topbar) auto 1fr; }
  .c-sidebar { position: static; height: auto; min-width: 0; border-right: 0; border-bottom: 1px solid var(--we-color-border); padding: 8px 12px; }
  .c-topbar { gap: 8px; padding: 0 12px; }
  .c-brand { font-size: 0; gap: 0; }
  .c-org { min-width: 0; flex: 1; }
  .c-topbar-end summary { max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
  .c-nav { display: flex; overflow-x: auto; gap: 4px; }
  .c-nav-label { display: none; }
  .c-nav a { white-space: nowrap; }
  .c-page { padding: 16px; }
}

/* Form header and tabs */
.c-formbar { border-bottom: 1px solid var(--we-color-border); background: var(--we-color-background); padding: 12px 24px 0; }
.c-formbar-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.c-formbar h1 { font-size: 20px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.c-tabs { display: flex; gap: 4px; overflow-x: auto; margin-top: 8px; }
.c-tabs a { padding: 10px 14px; color: var(--we-color-textMuted); text-decoration: none; border-bottom: 2px solid transparent; white-space: nowrap; font-weight: 500; }
.c-tabs a:hover { color: var(--we-color-text); }
.c-tabs a[aria-current="page"] { color: var(--we-color-accent); border-bottom-color: var(--we-color-accent); }
@media (max-width: 899px) { .c-formbar { padding: 12px 16px 0; } }

/* Buttons */
.c-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 15px; font-weight: 500;
  padding: 7px 14px; border-radius: var(--we-radius-md); border: 1px solid var(--we-color-border); background: var(--we-color-background);
  color: var(--we-color-text); cursor: pointer; text-decoration: none; line-height: 1.3; }
.c-btn:hover { background: var(--we-color-surface); }
.c-btn:disabled, .c-btn[aria-disabled="true"] { opacity: .55; cursor: not-allowed; }
.c-btn-primary { background: var(--we-color-accent); border-color: var(--we-color-accent); color: var(--we-color-accentText); }
.c-btn-primary:hover { background: color-mix(in srgb, var(--we-color-accent) 88%, black); }
.c-btn-danger { color: var(--we-color-danger); border-color: color-mix(in srgb, var(--we-color-danger) 40%, var(--we-color-border)); }
.c-btn-ghost { border-color: transparent; background: transparent; }
.c-btn-sm { padding: 4px 10px; font-size: 14px; }

/* Inputs */
.c-field { display: grid; gap: 6px; }
.c-label { font-weight: 600; font-size: 14px; }
.c-hint { color: var(--we-color-textMuted); font-size: 13px; margin: 0; }
.c-input, .c-select, .c-textarea { font: inherit; font-size: 15px; padding: 8px 10px; border-radius: var(--we-radius-md); border: 1px solid var(--we-color-border);
  background: var(--we-color-background); color: var(--we-color-text); width: 100%; }
.c-input[aria-invalid="true"] { border-color: var(--we-color-danger); }
.c-search { position: relative; min-width: 220px; flex: 1 1 260px; max-width: 360px; }
.c-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--we-color-textMuted); pointer-events: none; }
.c-search .c-input { padding-left: 34px; }
.c-error { color: var(--we-color-danger); margin: 0; font-size: 14px; }

/* Cards, grids and panels */
.c-card { background: var(--we-color-background); border: 1px solid var(--we-color-border); border-radius: var(--we-radius-lg); padding: 16px; box-shadow: var(--c-shadow); }
.c-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.c-choice { text-align: left; display: grid; gap: 8px; align-content: start; cursor: pointer; font: inherit; color: inherit; }
.c-choice:hover { border-color: color-mix(in srgb, var(--we-color-accent) 50%, var(--we-color-border)); }
.c-choice[aria-pressed="true"], .c-choice[aria-checked="true"] { border-color: var(--we-color-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--we-color-accent) 35%, transparent); }
.c-choice h3 { margin: 0; font-size: 16px; }
.c-choice p { margin: 0; color: var(--we-color-textMuted); font-size: 14px; }
.c-icon-tile { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--we-color-accent) 12%, transparent); color: var(--we-color-accent); }

/* Tables */
.c-table-wrap { overflow-x: auto; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-lg); background: var(--we-color-background); }
.c-table { width: 100%; border-collapse: collapse; font-size: 15px; }
.c-table th { text-align: left; font-size: 13px; font-weight: 600; color: var(--we-color-textMuted); background: var(--we-color-surface);
  padding: 10px 14px; border-bottom: 1px solid var(--we-color-border); white-space: nowrap; }
.c-table td { padding: 12px 14px; border-bottom: 1px solid var(--we-color-border); vertical-align: middle; }
.c-table tr:last-child td { border-bottom: 0; }
.c-table tbody tr:hover { background: color-mix(in srgb, var(--we-color-surface) 70%, transparent); }
.c-num, .c-table th.c-num { text-align: right; font-variant-numeric: tabular-nums; }
.c-cell-title { font-weight: 600; color: var(--we-color-text); text-decoration: none; }
a.c-cell-title:hover { color: var(--we-color-accent); text-decoration: underline; }
.c-cell-sub { display: block; color: var(--we-color-textMuted); font-size: 13px; font-weight: 400; }
@media (max-width: 720px) {
  .c-table-stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .c-table-stack, .c-table-stack tbody, .c-table-stack tr, .c-table-stack td { display: block; width: 100%; }
  .c-table-stack tr { padding: 8px 0; border-bottom: 1px solid var(--we-color-border); }
  .c-table-stack td { border: 0; padding: 4px 14px; text-align: left; }
  .c-table-stack td[data-label]::before { content: attr(data-label) ": "; color: var(--we-color-textMuted); font-size: 13px; }
}

/* Badges */
.c-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px;
  background: var(--we-color-surface); color: var(--we-color-textMuted); border: 1px solid var(--we-color-border); white-space: nowrap; }
.c-badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.c-badge[data-tone="live"] { color: var(--we-color-success); border-color: color-mix(in srgb, var(--we-color-success) 35%, transparent);
  background: color-mix(in srgb, var(--we-color-success) 10%, transparent); }
.c-badge[data-tone="closed"] { color: var(--we-color-warning); border-color: color-mix(in srgb, var(--we-color-warning) 35%, transparent);
  background: color-mix(in srgb, var(--we-color-warning) 10%, transparent); }
.c-badge[data-tone="danger"] { color: var(--we-color-danger); border-color: color-mix(in srgb, var(--we-color-danger) 35%, transparent);
  background: color-mix(in srgb, var(--we-color-danger) 10%, transparent); }

/* Menus (details/summary) */
.c-menu { position: relative; display: inline-block; }
.c-menu > summary { list-style: none; }
.c-menu > summary::-webkit-details-marker { display: none; }
.c-menu-list { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 200px; display: grid; padding: 6px;
  background: var(--we-color-background); border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); box-shadow: 0 8px 24px rgb(16 24 40 / .14); }
.c-menu-list a, .c-menu-list button { all: unset; box-sizing: border-box; display: block; padding: 8px 10px; border-radius: var(--we-radius-sm);
  cursor: pointer; font-size: 14px; color: var(--we-color-text); }
.c-menu-list a:hover, .c-menu-list button:hover, .c-menu-list a:focus-visible, .c-menu-list button:focus-visible { background: var(--we-color-surface); }
.c-menu-list button:disabled { opacity: .5; cursor: not-allowed; }
.c-menu-list .c-danger { color: var(--we-color-danger); }
.c-menu-list hr { border: 0; border-top: 1px solid var(--we-color-border); margin: 4px 0; }

/* Segmented control */
.c-segmented { display: inline-flex; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); overflow: hidden; }
.c-segmented button { font: inherit; font-size: 14px; padding: 7px 14px; border: 0; background: var(--we-color-background); color: var(--we-color-textMuted); cursor: pointer; }
.c-segmented button + button { border-left: 1px solid var(--we-color-border); }
.c-segmented button[aria-pressed="true"] { background: color-mix(in srgb, var(--we-color-accent) 12%, transparent); color: var(--we-color-accent); font-weight: 600; }

/* Empty and status states */
.c-empty { text-align: center; padding: 48px 24px; border: 1px dashed var(--we-color-border); border-radius: var(--we-radius-lg); background: var(--we-color-surface); }
.c-empty h2 { font-size: 18px; margin: 12px 0 4px; }
.c-empty p { color: var(--we-color-textMuted); margin: 0 0 16px; }
.c-status { min-height: 1.5em; margin: 0 0 12px; font-size: 14px; }
.c-skeleton { height: 14px; border-radius: 6px; background: linear-gradient(90deg, var(--we-color-surface), var(--we-color-border), var(--we-color-surface));
  background-size: 200% 100%; animation: c-shimmer 1.2s infinite; }
@keyframes c-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .c-skeleton { animation: none; } }
.c-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
