import { describe, expect, it } from "vitest";
import { privacyOf } from "./fields";
import { definitionFromTemplate } from "./templates";
import { validateDefinition } from "./validate-definition";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`field privacy (${runtime})`, () => {
  it("defaults to the field type's class and can be raised or lowered per field", () => {
    const def = definitionFromTemplate("contact", "Contact")!;
    const name = def.fields.find((f) => f.id === "f_name")!;
    expect(privacyOf(name)).toBe("ordinary");
    expect(privacyOf({ ...name, type: "file", settings: { allowedMimeTypes: ["text/plain"], maxFileBytes: 10, maxFiles: 1 } })).toBe("personal");
    expect(privacyOf({ ...name, privacy: "sensitive" })).toBe("sensitive");
  });

  it("is part of the contract with a fixed set of classes", () => {
    const def = definitionFromTemplate("contact", "Contact")!;
    def.fields[0]!.privacy = "personal";
    expect(validateDefinition(def).ok).toBe(true);
    (def.fields[0] as { privacy: string }).privacy = "secret";
    expect(validateDefinition(def)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "/fields/0/privacy" })] });
  });
});
