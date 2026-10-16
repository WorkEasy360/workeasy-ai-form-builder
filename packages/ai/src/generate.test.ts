import { blankDefinition, validateDefinition } from "@workeasy/form-engine";
import { describe, expect, it } from "vitest";
import { generateProposal } from "./generate.js";
import { ProviderError, type CompletionRequest, type JsonCompletionProvider } from "./provider.js";
import { stubProvider } from "./stub.js";

const VALID = JSON.stringify({
  title: "Contact",
  pages: [{ id: "p", title: "", fieldIds: ["n"] }],
  fields: [{ id: "n", type: "text", label: "Name", required: true, settings: {} }],
  rules: [],
  success: { message: "Thanks" },
});

/** Replies in order; records what it was asked. */
function scripted(...replies: Array<string | ProviderError>) {
  const calls: CompletionRequest[] = [];
  const provider: JsonCompletionProvider = {
    name: "test",
    model: "test-1",
    complete(request) {
      calls.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("no more replies");
      if (next instanceof ProviderError) return Promise.reject(next);
      return Promise.resolve({ text: next, usage: { inputTokens: 100, outputTokens: 10 } });
    },
  };
  return { provider, calls };
}

const request = { operation: "create" as const, prompt: "A contact form", base: blankDefinition("Draft") };

describe("generateProposal", () => {
  it("repairs an invalid reply once, telling the model what was wrong", async () => {
    const { provider, calls } = scripted('{"title": "<i>x</i>"}', VALID);
    const result = await generateProposal(provider, request, AbortSignal.timeout(5000));
    expect(result).toMatchObject({ ok: true, usage: { inputTokens: 200, outputTokens: 20 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(calls[1]!.messages[2]!.content).toContain("MARKUP_NOT_ALLOWED");
    expect(calls[0]!.messages[0]!.content).toContain("<request>\nA contact form\n</request>");
  });

  it("fails with the issues when the repair is invalid too, and never returns a partial form", async () => {
    const { provider, calls } = scripted("not json", '{"title": "Only a title"}');
    const result = await generateProposal(provider, request, AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("definition");
    expect(result).toMatchObject({ code: "invalid_output", usage: { inputTokens: 200, outputTokens: 20 } });
    expect(calls).toHaveLength(2);
  });

  it("passes provider failures on with the usage spent so far", async () => {
    const { provider } = scripted("not json", new ProviderError("provider_unavailable", true, { inputTokens: 5, outputTokens: 0 }));
    await expect(generateProposal(provider, request, AbortSignal.timeout(5000))).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      usage: { inputTokens: 105, outputTokens: 10 },
    });
  });
});

describe("stubProvider", () => {
  it("produces valid proposals for creating and editing, without a provider account", async () => {
    const created = await generateProposal(stubProvider(), { ...request, prompt: "Event feedback with a rating and phone number" }, AbortSignal.timeout(5000));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.definition.fields.map((f) => f.type)).toEqual(["text", "email", "phone", "date", "rating", "textarea"]);
    expect(validateDefinition(created.definition).ok).toBe(true);

    const edited = await generateProposal(stubProvider(), { operation: "edit", prompt: "Add a comments box", base: created.definition }, AbortSignal.timeout(5000));
    expect(edited.ok && edited.definition.fields.map((f) => f.id).slice(0, 6)).toEqual(created.definition.fields.map((f) => f.id));
    expect(edited.ok && edited.summary.addedFieldIds).toHaveLength(1);
  });
});
