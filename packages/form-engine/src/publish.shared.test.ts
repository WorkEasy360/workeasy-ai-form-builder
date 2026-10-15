import { describe, expect, it } from "vitest";
import { canonicalJson, publicProjection } from "./publish";
import { definitionFromTemplate } from "./templates";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`publication helpers (${runtime})`, () => {
  it("serializes equal values identically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    // Array order is meaningful and kept.
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("projects only what respondents need, as a copy", () => {
    const def = definitionFromTemplate("support-request", "Support")!;
    const withExtra = { ...def, internalNotes: "do not ship" } as typeof def;
    const projection = publicProjection(withExtra);
    expect(projection).not.toHaveProperty("internalNotes");
    expect(Object.keys(projection).toSorted()).toEqual(
      ["schemaVersion", "title", "locale", "pages", "fields", "rules", "theme", "success", ...(def.description ? ["description"] : [])].toSorted(),
    );
    expect(projection.fields).toEqual(def.fields);
    projection.fields[0]!.label = "changed";
    expect(def.fields[0]!.label).not.toBe("changed");
  });
});
