/**
 * Base styles for rendered fields. They use the form theme's CSS variables
 * (set by the container) and fall back to the Workeasy UI tokens.
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
.we-choice { display: flex; gap: 8px; align-items: center; }
.we-group .we-choices:has(.we-rating) { display: flex; flex-wrap: wrap; gap: 16px; }
.we-help { margin: 8px 0 0; color: var(--we-color-textMuted, #4B5563); }
.we-error { margin: 8px 0 0; color: var(--we-color-danger, #B91C1C); font-weight: 600; }
.we-field input:focus-visible, .we-field select:focus-visible, .we-field textarea:focus-visible {
  outline: 2px solid var(--we-color-focus, #2563EB); outline-offset: 2px;
}
`;
