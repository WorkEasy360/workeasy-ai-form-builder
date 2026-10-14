import { describe, expect, it } from "vitest";
import { createLogger } from "@workeasy/observability";
import { startRunner } from "./runner.js";

const logger = createLogger({ service: "worker-test", level: "silent" });

describe("worker runner", () => {
  it("runs tasks repeatedly and stops after the in-flight iteration", async () => {
    let runs = 0;
    let inFlight = false;
    const runner = startRunner({
      logger,
      intervalMs: 5,
      tasks: [
        {
          name: "count",
          async run() {
            inFlight = true;
            await new Promise((r) => setTimeout(r, 10));
            runs += 1;
            inFlight = false;
          },
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 60));
    await runner.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(inFlight).toBe(false);
    const after = runs;
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(after);
  });

  it("keeps running after a task throws", async () => {
    let calls = 0;
    const runner = startRunner({
      logger,
      intervalMs: 5,
      tasks: [
        {
          name: "flaky",
          async run() {
            calls += 1;
            throw new Error("boom");
          },
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 40));
    await runner.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
