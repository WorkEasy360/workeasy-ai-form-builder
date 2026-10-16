import { describe, expect, it } from "vitest";
import { errorCode, PermanentJobError, routesFor } from "./runner.js";

describe("routesFor", () => {
  it("maps each event to every job type subscribed to it", () => {
    const handle = () => Promise.resolve();
    expect(
      routesFor({
        "notify.email": { events: ["submission.accepted.v1"], handle },
        "notify.webhook": { events: ["submission.accepted.v1", "form.published.v1"], handle },
        "ai.generate": { handle },
      }),
    ).toEqual({ "submission.accepted.v1": ["notify.email", "notify.webhook"], "form.published.v1": ["notify.webhook"] });
  });
});

describe("errorCode", () => {
  it("keeps codes and drops messages", () => {
    expect(errorCode(new PermanentJobError("destination_rejected", "answer: 4111 1111"))).toBe("destination_rejected");
    expect(errorCode(Object.assign(new Error("connect to 10.0.0.1 failed"), { code: "ECONNREFUSED" }))).toBe("econnrefused");
    expect(errorCode(new Error("Ada's answer was wrong"))).toBe("handler_error");
    expect(errorCode(Object.assign(new Error("x"), { code: "42" }))).toBe("handler_error");
    expect(errorCode("plain string")).toBe("handler_error");
    expect(errorCode(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout");
  });
});
