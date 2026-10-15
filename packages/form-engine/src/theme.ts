import type { DefinitionIssue, Theme } from "@workeasy/form-schema";

/**
 * Theme colour checks (docs/01 §3: theme colours are contrast-checked,
 * WCAG 2.2 AA). Text needs 4.5:1 against the background (1.4.3); the accent
 * marks focus, selection and button edges, so it needs 3:1 (1.4.11). Text on
 * accent-coloured buttons is chosen by `readableTextOn`, which always reaches
 * 4.5:1.
 */

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_ACCENT_CONTRAST = 3;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #RRGGBB colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever is more readable on `background`. */
export function readableTextOn(background: string): "#FFFFFF" | "#000000" {
  return contrastRatio("#FFFFFF", background) >= contrastRatio("#000000", background) ? "#FFFFFF" : "#000000";
}

const ratio = (n: number) => `${(Math.floor(n * 10) / 10).toFixed(1)}:1`;

/** Contrast problems in a theme whose colours are well formed. */
export function themeIssues(theme: Theme, path = "/theme"): DefinitionIssue[] {
  if (![theme.text, theme.background, theme.accent].every(isHexColor)) return [];
  const issues: DefinitionIssue[] = [];
  const text = contrastRatio(theme.text, theme.background);
  if (text < MIN_TEXT_CONTRAST) {
    issues.push({
      path: `${path}/text`,
      code: "THEME_LOW_CONTRAST",
      message: `Text colour on the background has a contrast of ${ratio(text)}; it needs at least ${MIN_TEXT_CONTRAST}:1 to be readable.`,
    });
  }
  const accent = contrastRatio(theme.accent, theme.background);
  if (accent < MIN_ACCENT_CONTRAST) {
    issues.push({
      path: `${path}/accent`,
      code: "THEME_LOW_CONTRAST",
      message: `Accent colour on the background has a contrast of ${ratio(accent)}; it needs at least ${MIN_ACCENT_CONTRAST}:1 so buttons and focus outlines stay visible.`,
    });
  }
  return issues;
}
