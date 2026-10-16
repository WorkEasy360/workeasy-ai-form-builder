import { errorForStatus, ProviderError, providerFetch, type CompletionRequest, type JsonCompletionProvider } from "./provider.js";

interface ChatCompletion {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI Chat Completions in JSON mode. */
export function openAiProvider(options: { apiKey: string; model: string; baseUrl?: string }): JsonCompletionProvider {
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  return {
    name: "openai",
    model: options.model,
    async complete(request: CompletionRequest) {
      const res = await providerFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "system", content: request.system }, ...request.messages],
          response_format: { type: "json_object" },
          max_completion_tokens: request.maxOutputTokens,
        }),
        signal: request.signal,
      });
      if (!res.ok) throw errorForStatus(res.status);
      const body = (await res.json()) as ChatCompletion;
      const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
      const choice = body.choices?.[0];
      if (choice?.message?.refusal) throw new ProviderError("provider_refused", false, usage);
      if (choice?.finish_reason === "length") throw new ProviderError("output_truncated", false, usage);
      if (choice?.finish_reason === "content_filter") throw new ProviderError("provider_refused", false, usage);
      const text = choice?.message?.content;
      if (!text) throw new ProviderError("empty_output", true, usage);
      return { text, usage };
    },
  };
}
