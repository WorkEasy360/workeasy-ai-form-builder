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

  it("logs only allowlisted error fields and withholds database messages", () => {
    const { logger, lines } = captureLogger();
    const dbError = Object.assign(new Error('invalid input syntax for type uuid: "asha@example.com"'), {
      severity: "ERROR",
      code: "22P02",
      detail: "Key (email)=(asha@example.com) already exists.",
      where: "unnamed portal parameter $1 = '...'",
      table: "forms",
    });
    const httpError = Object.assign(new Error("request failed"), { response: { body: "secret-body" }, code: "ECONNRESET" });
    logger.error({ err: dbError }, "db failed");
    logger.error({ err: httpError }, "http failed");
    const out = lines.join("");
    expect(out).not.toContain("asha@example.com");
    expect(out).not.toContain("secret-body");
    const [db, http] = lines.map((l) => JSON.parse(l) as { err: Record<string, unknown> });
    expect(db!.err).toMatchObject({ type: "Error", code: "22P02", table: "forms" });
    expect(db!.err.detail).toBeUndefined();
    expect(http!.err).toMatchObject({ type: "Error", message: "request failed", code: "ECONNRESET" });
    expect(http!.err.response).toBeUndefined();
  });

  it("tags every line with the service name", () => {
    const { logger, lines } = captureLogger();
    logger.info("hello");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ service: "test", msg: "hello" });
  });
});
