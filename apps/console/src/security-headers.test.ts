import { describe, expect, it } from "vitest";
import consoleConfig from "../next.config";
import respondentConfig from "../../respondent/next.config";

/** SEC-01: response headers that stop framing, MIME sniffing and referrer leaks. */
async function headersFor(config: typeof consoleConfig, path: string): Promise<Record<string, string>> {
  const rules = (await config.headers?.()) ?? [];
  const out: Record<string, string> = {};
  for (const rule of rules) {
    // Next matches with path-to-regexp; these rules only use :path*, :slug and one lookahead group.
    const pattern = new RegExp(`^${rule.source.replace("/:path*", "(?:/.*)?").replace(":slug", "[^/]+")}$`);
    if (pattern.test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

describe("console security headers", () => {
  it.each(["/", "/o/x/forms", "/invite/abc", "/auth/login"])("never lets %s be framed or leak its URL", async (path) => {
    const h = await headersFor(consoleConfig, path);
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
  });
});

describe("respondent security headers", () => {
  it("lets only published form pages be embedded", async () => {
    expect((await headersFor(respondentConfig, "/f/f-abc123def456"))["Content-Security-Policy"]).toBe("frame-ancestors *");
    expect((await headersFor(respondentConfig, "/"))["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect((await headersFor(respondentConfig, "/"))["X-Frame-Options"]).toBe("DENY");
  });
});
