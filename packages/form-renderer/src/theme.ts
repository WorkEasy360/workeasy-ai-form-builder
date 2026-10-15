import { contrastRatio, MIN_ACCENT_CONTRAST, MIN_TEXT_CONTRAST, readableTextOn } from "@workeasy/form-engine";
import type { Theme } from "@workeasy/form-schema";
import type { CSSProperties } from "react";

/**
 * The full colour set a rendered form uses, derived from the four theme
 * tokens so that every colour keeps enough contrast against the form's
 * background: muted text 4.5:1, borders 3:1, errors 4.5:1. Button text on the
 * accent is black or white, whichever reads better.
 */
export interface ThemePalette {
  background: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  radius: number;
}

function hex(n: number): string {
  return Math.round(n).toString(16).padStart(2, "0").toUpperCase();
}

/** `amount` of `a` mixed with the rest `b`, in sRGB. */
function mix(a: string, b: string, amount: number): string {
  const ca = Number.parseInt(a.slice(1), 16);
  const cb = Number.parseInt(b.slice(1), 16);
  const channel = (shift: number) => ((ca >> shift) & 255) * amount + ((cb >> shift) & 255) * (1 - amount);
  return `#${hex(channel(16))}${hex(channel(8))}${hex(channel(0))}`;
}

/** The softest mix of `text` into `background` that still reaches `min` contrast. */
function softest(text: string, background: string, start: number, min: number): string {
  for (let amount = start; amount < 1; amount += 0.05) {
    const candidate = mix(text, background, amount);
    if (contrastRatio(candidate, background) >= min) return candidate;
  }
  return text;
}

const DANGER_ON_LIGHT = "#B91C1C";
const DANGER_ON_DARK = "#FCA5A5";

export function themePalette(theme: Theme): ThemePalette {
  const { background, text, accent } = theme;
  const danger = [DANGER_ON_LIGHT, DANGER_ON_DARK].find((c) => contrastRatio(c, background) >= MIN_TEXT_CONTRAST) ?? text;
  return {
    background,
    text,
    textMuted: softest(text, background, 0.7, MIN_TEXT_CONTRAST),
    border: softest(text, background, 0.45, MIN_ACCENT_CONTRAST),
    accent,
    accentText: readableTextOn(accent),
    danger,
    radius: theme.radius,
  };
}

/**
 * CSS custom properties for a themed container. The renderer's styles read
 * these, so a preview, the builder canvas and the respondent page all render
 * the theme the same way.
 */
export function themeStyle(theme: Theme): CSSProperties {
  const p = themePalette(theme);
  return {
    "--we-color-background": p.background,
    "--we-color-text": p.text,
    "--we-color-textMuted": p.textMuted,
    "--we-color-border": p.border,
    "--we-color-accent": p.accent,
    "--we-color-accentText": p.accentText,
    "--we-color-danger": p.danger,
    "--we-color-focus": p.accent,
    "--we-form-radius": `${p.radius}px`,
    background: p.background,
    color: p.text,
  } as CSSProperties;
}
