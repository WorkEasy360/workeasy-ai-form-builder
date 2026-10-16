import { describe, expect, it } from "vitest";
import { csvCell, csvRow, neutralizeFormula } from "./csv.js";

describe("CSV encoding", () => {
  it("neutralizes every spreadsheet formula prefix in readable exports", () => {
    for (const payload of ["=HYPERLINK(\"http://evil\",\"x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
      expect(neutralizeFormula(payload)).toBe(`'${payload}`);
    }
    expect(neutralizeFormula("Plain text")).toBe("Plain text");
    expect(neutralizeFormula("a=b")).toBe("a=b");
  });

  it("quotes cells that need it and doubles quotes", () => {
    expect(csvCell("Hello, world", false)).toBe('"Hello, world"');
    expect(csvCell('Say "hi"', false)).toBe('"Say ""hi"""');
    expect(csvCell("two\nlines", false)).toBe('"two\nlines"');
    expect(csvCell("=1,2", false)).toBe(`"'=1,2"`);
  });

  it("keeps raw values exactly", () => {
    expect(csvCell("=1+1", true)).toBe("=1+1");
    expect(csvRow(["a", "b,c"], true)).toBe('a,"b,c"\r\n');
  });
});
