/**
 * Base styles for rendered fields and forms. They use the form theme's CSS
 * variables (set by `themeStyle` on the container) and fall back to the
 * Workeasy UI tokens. Layout is a single column that fits any width from a
 * 320px phone up and responds to the form's own width (container queries).
 * Nothing animates, so reduced motion needs nothing extra.
 */
export const RENDERER_CSS = `
.we-field { border: 0; margin: 0 0 24px; padding: 0; min-width: 0; }
.we-label { display: block; font-weight: 600; margin-bottom: 8px; padding: 0; }
.we-required { color: var(--we-color-danger, #B91C1C); }
.we-input {
  display: block; width: 100%; box-sizing: border-box; font: inherit;
  padding: 8px; border: 1px solid var(--we-color-border, #9CA3AF);
  border-radius: var(--we-form-radius, 8px); background: var(--we-color-background, #fff); color: inherit;
}
.we-input[aria-invalid="true"], .we-group[aria-invalid="true"] .we-choices { border-color: var(--we-color-danger, #B91C1C); }
.we-choices { display: grid; gap: 8px; }
.we-parts { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.we-part { display: grid; gap: 4px; min-width: 0; }
.we-part[data-part="line1"], .we-part[data-part="line2"] { grid-column: 1 / -1; }
.we-part-label { font-size: 14px; }
@media (max-width: 480px) { .we-parts { grid-template-columns: minmax(0, 1fr); } }
.we-slider { display: flex; align-items: center; gap: 10px; }
.we-range { flex: 1; accent-color: var(--we-form-accent, var(--we-color-accent, #4F46E5)); }
.we-range[data-unset="true"] { opacity: .55; }
.we-slider-value { min-width: 3ch; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.we-slider-clear { margin-top: 6px; }
.we-section { margin: 8px 0 4px; padding-bottom: 6px; border-bottom: 1px solid var(--we-color-border, #E5E7EB); }
.we-section-title { margin: 0; font-size: 1.15em; }
.we-description p { margin: 0 0 6px; }
.we-choice { display: flex; gap: 8px; align-items: center; }
.we-choice input { accent-color: var(--we-color-accent, #4F46E5); }
.we-group .we-choices:has(.we-rating) { display: flex; flex-wrap: wrap; gap: 16px; }
.we-help { margin: 8px 0 0; color: var(--we-color-textMuted, #4B5563); }
.we-error { margin: 8px 0 0; color: var(--we-color-danger, #B91C1C); font-weight: 600; }
.we-field input:focus-visible, .we-field select:focus-visible, .we-field textarea:focus-visible {
  outline: 2px solid var(--we-color-focus, #2563EB); outline-offset: 2px;
}
.we-surface { container-type: inline-size; min-height: 100%; background: var(--we-color-background, #fff); color: var(--we-color-text, #111827); }
.we-form { box-sizing: border-box; width: 100%; max-width: 680px; margin: 0 auto; padding: 24px 16px;
  font-size: 16px; line-height: 1.5; overflow-wrap: anywhere; }
.we-title { font-size: 1.6em; margin: 0 0 8px; }
.we-description { margin: 0 0 24px; white-space: pre-line; }
.we-page-header { margin: 16px 0 24px; }
.we-page-title { font-size: 1.25em; margin: 0; }
.we-progress { margin: 4px 0 0; color: var(--we-color-textMuted, #4B5563); }
.we-title:focus, .we-page-title:focus, .we-error-summary:focus { outline: 2px solid var(--we-color-focus, #2563EB); outline-offset: 4px; }
.we-error-summary { border: 2px solid var(--we-color-danger, #B91C1C); border-radius: var(--we-form-radius, 8px);
  padding: 12px 16px; margin: 0 0 24px; }
.we-error-summary-title { font-weight: 700; margin: 0; }
.we-error-summary ul { margin: 8px 0 0; padding-left: 20px; }
.we-error-summary a { color: var(--we-color-danger, #B91C1C); font-weight: 600; }
.we-success { margin: 16px 0 24px; white-space: pre-line; }
.we-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.we-button { font: inherit; min-height: 44px; padding: 8px 20px; cursor: pointer;
  border: 1px solid var(--we-color-border, #9CA3AF); border-radius: var(--we-form-radius, 8px);
  background: var(--we-color-background, #fff); color: var(--we-color-text, #111827); }
.we-button-primary { border-color: var(--we-color-accent, #4F46E5); background: var(--we-color-accent, #4F46E5);
  color: var(--we-color-accentText, #fff); font-weight: 600; }
.we-button:focus-visible { outline: 2px solid var(--we-color-focus, #2563EB); outline-offset: 2px; }
.we-button:disabled { opacity: .6; cursor: progress; }
.we-files { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
.we-files li { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 8px 12px;
  border: 1px solid var(--we-color-border, #9CA3AF); border-radius: var(--we-form-radius, 8px); }
.we-files li[data-status="failed"] { border-color: var(--we-color-danger, #B91C1C); }
.we-file-name { font-weight: 600; overflow-wrap: anywhere; }
.we-file-status { color: var(--we-color-textMuted, #4B5563); flex: 1 1 auto; }
.we-files li[data-status="failed"] .we-file-status { color: var(--we-color-danger, #B91C1C); }
.we-file-remove { min-height: 36px; padding: 4px 12px; }
/* Narrow forms (a phone, or the builder's mobile preview) get full-width buttons. */
@container (max-width: 480px) {
  .we-actions .we-button { flex: 1 1 auto; }
}
`;
