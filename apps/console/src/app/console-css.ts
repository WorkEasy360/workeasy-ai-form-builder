/**
 * Form-builder styles on top of the shared WorkEasy360 vocabulary
 * (`ADMIN_CSS` in @workeasy/ui). Only what this product needs and the suite
 * does not: the form header with its tabs, template cards, wide pages, the
 * builder's full-width focus mode, and rendered forms that keep their own
 * theme inside the console. Every value comes from a `--we-*` token.
 */
export const CONSOLE_CSS = `
/* A rendered form (preview, builder canvas) takes its colours from its own theme, not the console's. */
.we-surface :is(h1, h2, h3, h4), .b-canvas :is(h1, h2, h3, h4) { color: inherit; letter-spacing: normal; }

/* The builder needs the whole width: the sidebar becomes the drawer at every width. */
.c-app[data-focus="true"] { grid-template-columns: minmax(0, 1fr); }
.c-app[data-focus="true"] .c-topbar, .c-app[data-focus="true"] .c-main { grid-column: 1; }
.c-app[data-focus="true"] .c-btn.c-menu-toggle { display: inline-flex; }
.c-app[data-focus="true"] .c-sidebar { position: fixed; inset: 0 auto 0 0; width: min(84vw, 300px); z-index: 40; transform: translateX(-100%);
  transition: transform var(--we-motion-base) var(--we-motion-ease); }
.c-app[data-focus="true"][data-nav-open="true"] .c-sidebar { transform: none; box-shadow: var(--we-shadow-lg); }
.c-app[data-focus="true"][data-nav-open="true"]::after { content: ""; position: fixed; inset: 0; background: var(--we-overlay); z-index: 30; }
.c-page-wide { max-width: none; }
.c-menu-list .c-danger, .c-menu-list .c-danger svg { color: var(--we-error-text); }

/* Form header: name, status and the form's tabs */
.c-formbar { border-bottom: 1px solid var(--we-border); background: var(--we-surface); padding: 12px 24px 0; }
.c-formbar-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.c-formbar h1 { font-size: var(--we-font-size-lg); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.c-formbar .c-tabs { margin: 8px 0 0; border-bottom: 0; }
.c-formbar .c-tabs a { display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 959px) { .c-formbar { padding: 12px 16px 0; } }

/* Template and choice cards (new form, organization picker) */
.c-choice { text-align: left; display: grid; gap: 8px; align-content: start; cursor: pointer; font: inherit; color: inherit; transition: var(--c-transition); }
.c-choice:hover { border-color: var(--we-border-strong); }
.c-choice[aria-pressed="true"], .c-choice[aria-checked="true"] { border-color: var(--we-focus); box-shadow: var(--c-ring); }
.c-choice h2, .c-choice h3 { margin: 0; font-size: var(--we-font-size-md); }
.c-choice p { margin: 0; color: var(--we-text-secondary); font-size: var(--we-font-size-sm); }
`;
