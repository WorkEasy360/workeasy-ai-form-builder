import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFromSettings } from "./config.js";
import { geminiProvider } from "./gemini.js";
import { openAiProvider } from "./openai.js";

/** Replaces fetch with one canned response; returns the captured request. */
function respondWith(status: number, body: unknown) {
  const captured: { url?: string; init?: RequestInit } = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    }),
  );
  return captured;
}

const request = { system: "SYS", messages: [{ role: "user" as const, content: "make a form" }], maxOutputTokens: 1000, signal: AbortSignal.timeout(5000) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openAiProvider", () => {
  const provider = openAiProvider({ apiKey: "sk-test-key", model: "test-model" });

  it("asks for a JSON object and returns the text and usage", async () => {
    const sent = respondWith(200, { choices: [{ finish_reason: "stop", message: { content: '{"title":"x"}' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    expect(await provider.complete(request)).toEqual({ text: '{"title":"x"}', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((sent.init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key");
    const body = JSON.parse(String(sent.init!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      response_format: { type: "json_object" },
      max_completion_tokens: 1000,
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "make a form" },
      ],
    });
  });

  it.each([
    [401, "provider_auth", false],
    [404, "provider_model_not_found", false],
    [400, "provider_rejected", false],
    [429, "provider_rate_limited", true],
    [503, "provider_unavailable", true],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    respondWith(status, { error: { message: "sk-test-key is not valid" } });
    await expect(provider.complete(request)).rejects.toMatchObject({ code, retryable, message: code });
  });

  it("treats refusals and truncated replies as failures, keeping the usage", async () => {
    respondWith(200, { choices: [{ message: { refusal: "no" } }], usage: { prompt_tokens: 9, completion_tokens: 1 } });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: "provider_refused", retryable: false, usage: { inputTokens: 9, outputTokens: 1 } });
    respondWith(200, { choices: [{ finish_reason: "length", message: { content: '{"ti' } }] });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: "output_truncated" });
  });

  it("reports network failures as retryable without the error's details", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed: https://api.openai.com sk-test-key"))));
    const err: unknown = await provider.complete(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_unreachable", retryable: true });
    expect(String((err as Error).message)).not.toContain("sk-test");
  });
});

describe("geminiProvider", () => {
  const provider = geminiProvider({ apiKey: "g-test-key", model: "test-model" });

  it("sends the key in a header, never the URL, and asks for JSON", async () => {
    const sent = respondWith(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"title":' }, { text: '"x"}' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 } });
    expect(await provider.complete({ ...request, messages: [...request.messages, { role: "assistant", content: "{}" }] })).toEqual({
      text: '{"title":"x"}',
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    expect(sent.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent");
    expect(sent.url).not.toContain("g-test-key");
    expect((sent.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-test-key");
    expect(JSON.parse(String(sent.init!.body))).toMatchObject({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [
        { role: "user", parts: [{ text: "make a form" }] },
        { role: "model", parts: [{ text: "{}" }] },
      ],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1000 },
    });
  });

  it("treats blocked prompts and safety stops as refusals", async () => {
    respondWith(200, { promptFeedback: { blockReason: "SAFETY" } });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: "provider_refused", retryable: false });
    respondWith(200, { candidates: [{ finishReason: "SAFETY" }] });
    await expect(provider.complete(request)).rejects.toMatchObject({ code: "provider_refused" });
    respondWith(500, {});
    await expect(provider.complete(request)).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
  });
});

describe("providerFromSettings", () => {
  it("is off by default and needs a model and key for real providers", () => {
    expect(providerFromSettings({})).toBeUndefined();
    expect(providerFromSettings({ AI_PROVIDER: "stub" })?.name).toBe("stub");
    expect(() => providerFromSettings({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toThrow(/AI_MODEL/);
    expect(() => providerFromSettings({ AI_PROVIDER: "gemini", AI_MODEL: "m" })).toThrow(/GEMINI_API_KEY/);
    expect(providerFromSettings({ AI_PROVIDER: "gemini", AI_MODEL: "m", GEMINI_API_KEY: "k" })).toMatchObject({ name: "gemini", model: "m" });
  });
});
