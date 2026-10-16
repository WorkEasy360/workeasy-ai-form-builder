import { errorForStatus, ProviderError, providerFetch, type CompletionRequest, type JsonCompletionProvider } from "./provider.js";

interface GenerateContentResponse {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

/** Gemini generateContent with a JSON response type. */
export function geminiProvider(options: { apiKey: string; model: string; baseUrl?: string }): JsonCompletionProvider {
  const baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  return {
    name: "gemini",
    model: options.model,
    async complete(request: CompletionRequest) {
      const res = await providerFetch(`${baseUrl}/models/${encodeURIComponent(options.model)}:generateContent`, {
        method: "POST",
        // The key goes in a header, never the URL, so it stays out of request logs.
        headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: request.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: request.maxOutputTokens },
        }),
        signal: request.signal,
      });
      if (!res.ok) throw errorForStatus(res.status);
      const body = (await res.json()) as GenerateContentResponse;
      const usage = { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0 };
      if (body.promptFeedback?.blockReason) throw new ProviderError("provider_refused", false, usage);
      const candidate = body.candidates?.[0];
      if (candidate?.finishReason && REFUSALS.has(candidate.finishReason)) throw new ProviderError("provider_refused", false, usage);
      if (candidate?.finishReason === "MAX_TOKENS") throw new ProviderError("output_truncated", false, usage);
      const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      if (!text) throw new ProviderError("empty_output", true, usage);
      return { text, usage };
    },
  };
}
