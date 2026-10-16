import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "./backoff.js";

describe("backoffDelayMs", () => {
  it("doubles the ceiling per attempt and draws from its upper half", () => {
    expect(backoffDelayMs(1, { baseMs: 1000, random: () => 0 })).toBe(500);
    expect(backoffDelayMs(1, { baseMs: 1000, random: () => 0.999999 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000, random: () => 0 })).toBe(2000);
    expect(backoffDelayMs(3, { baseMs: 1000, random: () => 0.5 })).toBe(3000);
  });

  it("never exceeds the cap, however many attempts", () => {
    for (const attempt of [10, 50, 1000]) {
      expect(backoffDelayMs(attempt, { baseMs: 1000, maxMs: 60_000, random: () => 0.999999 })).toBeLessThanOrEqual(60_000);
    }
  });
});
