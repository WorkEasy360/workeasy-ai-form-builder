import { describe, expect, it } from "vitest";
import { canonicalDecimal, compareDecimal, decimalFromLiteral } from "./decimal";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`decimals (${runtime})`, () => {
  it("canonicalizes without floating point", () => {
    expect(canonicalDecimal("0150.50")).toBe("150.5");
    expect(canonicalDecimal("-0.000")).toBe("0");
    expect(canonicalDecimal("10")).toBe("10");
    expect(canonicalDecimal("0.10000000000000000001")).toBe("0.10000000000000000001");
    for (const bad of ["", "1e3", "1.", ".5", "+1", "1,5", " 1", "NaN", "Infinity"]) expect(canonicalDecimal(bad)).toBeUndefined();
  });

  it("compares exactly where binary floats would not", () => {
    expect(compareDecimal("0.3", "0.1")).toBe(1);
    expect(compareDecimal("0.30000000000000000001", "0.3")).toBe(1);
    expect(compareDecimal("100", "100.0")).toBe(0);
    expect(compareDecimal("-2", "-10")).toBe(1);
    expect(compareDecimal("-0.5", "0")).toBe(-1);
    expect(compareDecimal("9.99", "10")).toBe(-1);
  });

  it("accepts number literals only in plain notation", () => {
    expect(decimalFromLiteral(100)).toBe("100");
    expect(decimalFromLiteral(0.25)).toBe("0.25");
    expect(decimalFromLiteral(1e21)).toBeUndefined();
    expect(decimalFromLiteral(Number.NaN)).toBeUndefined();
    expect(decimalFromLiteral(true)).toBeUndefined();
  });

  it("caps the number of digits", () => {
    expect(canonicalDecimal("1".repeat(30))).toBe("1".repeat(30));
    expect(canonicalDecimal("1".repeat(31))).toBeUndefined();
  });
});
