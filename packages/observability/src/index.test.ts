import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ service: "test", destination }), lines };
}

describe("createLogger", () => {
  it("never writes answers, tokens, prompts or auth headers", () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        answers: { f_email: "asha@example.com" },
        session: { token: "cap_secret" },
        job: { prompt: "make a form" },
        req: { headers: { authorization: "Bearer abc", cookie: "sid=1" } },
        formId: "form-1",
      },
      "submission",
    );
    const out = lines.join("");
    for (const secret of ["asha@example.com", "cap_secret", "make a form", "Bearer abc", "sid=1"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("form-1");
  });

  it("tags every line with the service name", () => {
    const { logger, lines } = captureLogger();
    logger.info("hello");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ service: "test", msg: "hello" });
  });
});
