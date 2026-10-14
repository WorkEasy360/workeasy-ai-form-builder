/**
 * Neutral starting tokens (docs/01 §3): neutral surfaces, a single brand
 * accent, an 8px spacing scale and visible focus. Replace with official
 * Workeasy tokens once they are supplied.
 */
export const tokens = {
  color: {
    background: "#FFFFFF",
    surface: "#F9FAFB",
    border: "#E5E7EB",
    text: "#111827",
    textMuted: "#4B5563",
    accent: "#4F46E5",
    accentText: "#FFFFFF",
    focus: "#2563EB",
    danger: "#B91C1C",
  },
  colorDark: {
    background: "#0B0F19",
    surface: "#111827",
    border: "#1F2937",
    text: "#F9FAFB",
    textMuted: "#9CA3AF",
    accent: "#818CF8",
    accentText: "#0B0F19",
    focus: "#60A5FA",
    danger: "#F87171",
  },
  space: { 1: "8px", 2: "16px", 3: "24px", 4: "32px", 6: "48px" },
  radius: { sm: "4px", md: "8px", lg: "12px" },
  font: {
    family: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    sizeBase: "16px",
    lineHeight: "1.5",
  },
} as const;

type ColorTokens = { readonly [K in keyof typeof tokens.color]: string };

function colorVars(colors: ColorTokens): string {
  return Object.entries(colors)
    .map(([name, value]) => `--we-color-${name}:${value};`)
    .join("");
}

/** CSS custom properties for the token set, with a dark-mode override. */
export function tokensCss(): string {
  const space = Object.entries(tokens.space)
    .map(([step, value]) => `--we-space-${step}:${value};`)
    .join("");
  const radius = Object.entries(tokens.radius)
    .map(([name, value]) => `--we-radius-${name}:${value};`)
    .join("");
  return [
    `:root{${colorVars(tokens.color)}${space}${radius}--we-font-family:${tokens.font.family};}`,
    `@media (prefers-color-scheme: dark){:root{${colorVars(tokens.colorDark)}}}`,
  ].join("\n");
}
