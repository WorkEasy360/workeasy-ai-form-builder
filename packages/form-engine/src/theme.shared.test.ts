import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, definitionFromTemplate } from "./templates";
import { contrastRatio, readableTextOn, themeIssues } from "./theme";
import { validateDefinition, validateDraft } from "./validate-definition";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`theme contrast (${runtime})`, () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
    // Order does not matter.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#767676"), 10);
    // #767676 is the classic lightest grey that passes 4.5:1 on white.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeLessThan(4.5);
  });

  it("picks readable button text for any accent", () => {
    for (const accent of ["#4F46E5", "#FACC15", "#777777", "#000000", "#FFFFFF", "#22C55E"]) {
      expect(contrastRatio(readableTextOn(accent), accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("accepts the default theme", () => {
    expect(themeIssues(DEFAULT_THEME)).toEqual([]);
  });

  it("reports low-contrast text and accent, with the measured ratio", () => {
    const issues = themeIssues({ ...DEFAULT_THEME, text: "#9CA3AF", accent: "#E0E7FF" });
    expect(issues.map((i) => `${i.path}:${i.code}`)).toEqual(["/theme/text:THEME_LOW_CONTRAST", "/theme/accent:THEME_LOW_CONTRAST"]);
    expect(issues[0]!.message).toMatch(/contrast of 2\.\d:1; it needs at least 4\.5:1/);
  });

  it("blocks publishing a low-contrast form but still saves the draft", () => {
    const def = definitionFromTemplate("contact", "Contact")!;
    def.theme = { ...def.theme, background: "#111827", text: "#1F2937", accent: "#A5B4FC" };
    expect(validateDefinition(def)).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "THEME_LOW_CONTRAST" })] });
    expect(validateDraft(def)).toMatchObject({ ok: true, issues: [expect.objectContaining({ path: "/theme/text" })] });
  });

  it("accepts a dark theme with enough contrast", () => {
    expect(themeIssues({ accent: "#A5B4FC", background: "#111827", text: "#F9FAFB", radius: 12 })).toEqual([]);
  });
});
