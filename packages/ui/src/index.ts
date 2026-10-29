/**
 * WorkEasy360 design tokens, shared by every WorkEasy360 product.
 *
 * Two layers:
 * - `--we-*` semantic tokens for product chrome (shell, buttons, tables,
 *   badges). Components read these and never hard-code colours.
 * - `--we-color-*` form-theme tokens, read by the form renderer. A form's own
 *   theme overrides them on its container (`themeStyle`), so the defaults here
 *   only apply outside a themed form.
 *
 * Every text/background pair below was contrast-checked for WCAG 2.2 AA:
 * text 4.5:1, borders and focus indicators 3:1. Secondary text reaches 4.5:1
 * on `surface` and `background` only, not on `surface-muted`. Brand green is
 * never used as small text on white; `accent-strong` is the text-safe green.
 */

/** Core brand colours. */
export const brand = {
  navyDeep: "#112532",
  navy: "#1B3040",
  navySoft: "#27455A",
  green: "#4ADE80",
  greenHover: "#22C55E",
  greenLight: "#DCFCE7",
  greenDark: "#166534",
  white: "#FFFFFF",
} as const;

/** Semantic colours: light mode. Names map to `--we-<name>`. */
const light = {
  // Brand roles. Primary is navy for structure, headings and selected states;
  // accent is green for the main action, active indicators and progress.
  primary: brand.navy,
  "primary-hover": brand.navyDeep,
  "on-primary": brand.white,
  accent: brand.green,
  "accent-hover": brand.greenHover,
  "on-accent": brand.navyDeep,
  "accent-soft": brand.greenLight,
  "accent-strong": brand.greenDark,
  // Surfaces
  background: "#F8FAFC",
  surface: "#FFFFFF",
  "surface-muted": "#F1F5F9",
  "surface-hover": "#F1F5F9",
  "surface-selected": "#EEF2F6",
  border: "#E2E8F0",
  "border-strong": "#8494A9",
  overlay: "rgb(17 37 50 / .45)",
  // Text
  "text-primary": brand.navy,
  "text-body": "#334155",
  "text-secondary": "#64748B",
  link: "#1D4ED8",
  focus: "#2563EB",
  // Semantic: solid for icons and charts, fg/bg for text on a pale surface.
  success: "#16A34A",
  "success-fg": "#166534",
  "success-bg": "#DCFCE7",
  info: "#2563EB",
  "info-fg": "#1D4ED8",
  "info-bg": "#DBEAFE",
  warning: "#D97706",
  "warning-fg": "#92400E",
  "warning-bg": "#FEF3C7",
  error: "#DC2626",
  "error-fg": "#B91C1C",
  "error-bg": "#FEE2E2",
  ai: "#7C3AED",
  "ai-fg": "#6D28D9",
  "ai-bg": "#EDE9FE",
  // Navigation sidebar (navy in both modes)
  "sidebar-bg": brand.navy,
  "sidebar-border": brand.navySoft,
  "sidebar-text": "#CBD5E1",
  "sidebar-label": "#94A3B8",
  "sidebar-hover": brand.navySoft,
  "sidebar-active": brand.navySoft,
  "sidebar-active-text": brand.white,
  "sidebar-indicator": brand.green,
  // Charts: navy leads, green highlights; the rest in documented order.
  "chart-1": brand.navy,
  "chart-2": "#16A34A",
  "chart-3": "#2563EB",
  "chart-4": "#7C3AED",
  "chart-5": "#D97706",
  "chart-6": "#64748B",
  "chart-grid": "#E2E8F0",
} as const;

type SemanticColors = { readonly [K in keyof typeof light]: string };

/** Semantic colours: dark mode. */
const dark: SemanticColors = {
  primary: "#F1F5F9",
  "primary-hover": "#FFFFFF",
  "on-primary": brand.navyDeep,
  accent: brand.green,
  "accent-hover": "#86EFAC",
  "on-accent": brand.navyDeep,
  "accent-soft": "#14352A",
  "accent-strong": brand.green,
  background: "#0B1620",
  surface: brand.navyDeep,
  "surface-muted": brand.navy,
  "surface-hover": brand.navy,
  "surface-selected": brand.navy,
  border: brand.navySoft,
  "border-strong": "#5B7489",
  overlay: "rgb(0 0 0 / .6)",
  "text-primary": "#F1F5F9",
  "text-body": "#CBD5E1",
  "text-secondary": "#94A3B8",
  link: "#93C5FD",
  focus: "#60A5FA",
  success: "#22C55E",
  "success-fg": "#4ADE80",
  "success-bg": "#14352A",
  info: "#3B82F6",
  "info-fg": "#93C5FD",
  "info-bg": "#172F4F",
  warning: "#F59E0B",
  "warning-fg": "#FBBF24",
  "warning-bg": "#3A2A10",
  error: "#EF4444",
  "error-fg": "#FCA5A5",
  "error-bg": "#3F1A1D",
  ai: "#8B5CF6",
  "ai-fg": "#C4B5FD",
  "ai-bg": "#2A1F4A",
  "sidebar-bg": "#0E1E29",
  "sidebar-border": brand.navy,
  "sidebar-text": "#CBD5E1",
  "sidebar-label": "#94A3B8",
  "sidebar-hover": brand.navy,
  "sidebar-active": brand.navy,
  "sidebar-active-text": brand.white,
  "sidebar-indicator": brand.green,
  "chart-1": "#94A3B8",
  "chart-2": brand.green,
  "chart-3": "#60A5FA",
  "chart-4": "#A78BFA",
  "chart-5": "#FBBF24",
  "chart-6": "#CBD5E1",
  "chart-grid": brand.navySoft,
};

/** Form-theme defaults for the renderer (`--we-color-*`), outside a themed form. */
const formLight = {
  background: "#FFFFFF",
  surface: "#F8FAFC",
  border: "#8494A9",
  text: brand.navy,
  textMuted: "#64748B",
  accent: brand.navy,
  accentText: brand.white,
  focus: "#2563EB",
  danger: "#B91C1C",
  success: "#166534",
  warning: "#92400E",
} as const;

type FormColors = { readonly [K in keyof typeof formLight]: string };

const formDark: FormColors = {
  background: brand.navyDeep,
  surface: brand.navy,
  border: "#5B7489",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  accent: brand.green,
  accentText: brand.navyDeep,
  focus: "#60A5FA",
  danger: "#FCA5A5",
  success: "#4ADE80",
  warning: "#FBBF24",
};

export const tokens = {
  brand,
  color: light,
  colorDark: dark,
  form: formLight,
  formDark,
  /** 4px base: `--we-space-N` is N × 4px. */
  space: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px", 8: "32px", 10: "40px", 12: "48px" },
  radius: { sm: "6px", md: "8px", lg: "12px", xl: "16px", full: "999px" },
  font: {
    family: 'var(--we-font-inter, "Inter"), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  /** Type scale: [size, line-height, weight]. */
  text: {
    xs: ["12px", "16px", "400"],
    sm: ["13px", "18px", "400"],
    base: ["14px", "20px", "400"],
    md: ["16px", "24px", "600"],
    lg: ["18px", "26px", "600"],
    xl: ["24px", "32px", "600"],
  },
  shadow: {
    light: {
      xs: "0 1px 2px rgb(17 37 50 / .05)",
      sm: "0 1px 2px rgb(17 37 50 / .06), 0 1px 3px rgb(17 37 50 / .08)",
      md: "0 4px 12px rgb(17 37 50 / .08), 0 1px 3px rgb(17 37 50 / .06)",
      lg: "0 12px 32px rgb(17 37 50 / .14), 0 2px 6px rgb(17 37 50 / .08)",
    },
    dark: {
      xs: "0 1px 2px rgb(0 0 0 / .4)",
      sm: "0 1px 3px rgb(0 0 0 / .5)",
      md: "0 4px 12px rgb(0 0 0 / .5)",
      lg: "0 12px 32px rgb(0 0 0 / .6)",
    },
  },
  motion: { fast: "150ms", base: "200ms", ease: "cubic-bezier(.2, 0, 0, 1)" },
  size: {
    "sidebar-width": "240px",
    "topbar-height": "56px",
    "control-height": "36px",
    "control-height-sm": "30px",
    "nav-item-height": "36px",
    "icon-size": "18px",
    "content-max": "1200px",
  },
} as const;

const vars = (prefix: string, values: Readonly<Record<string, string>>) =>
  Object.entries(values)
    .map(([name, value]) => `--${prefix}${name}:${value};`)
    .join("");

/** CSS custom properties for the whole token set, with a dark-mode override. */
export function tokensCss(): string {
  const text = Object.entries(tokens.text)
    .map(([step, [size, lineHeight, weight]]) => `--we-text-${step}:${size};--we-leading-${step}:${lineHeight};--we-weight-${step}:${weight};`)
    .join("");
  const base = [
    vars("we-", tokens.color),
    vars("we-color-", tokens.form),
    vars("we-space-", tokens.space),
    vars("we-radius-", tokens.radius),
    vars("we-shadow-", tokens.shadow.light),
    vars("we-", tokens.size),
    text,
    `--we-font-family:${tokens.font.family};--we-font-mono:${tokens.font.mono};`,
    `--we-duration-fast:${tokens.motion.fast};--we-duration:${tokens.motion.base};--we-ease:${tokens.motion.ease};`,
    "color-scheme:light;",
  ].join("");
  const darkVars = [vars("we-", tokens.colorDark), vars("we-color-", tokens.formDark), vars("we-shadow-", tokens.shadow.dark), "color-scheme:dark;"].join("");
  return [`:root{${base}}`, `@media (prefers-color-scheme: dark){:root{${darkVars}}}`].join("\n");
}
