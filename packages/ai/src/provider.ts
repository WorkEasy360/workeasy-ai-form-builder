/**
 * The boundary to an AI provider (docs/03 §4, ADR-010). An adapter sends a
 * system instruction and a conversation and returns the model's JSON text
 * and token usage. It gets no tools: no database, publishing, email or
 * credentials. Its output is untrusted until parsed and validated.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionRequest {
  system: string;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** Cap on the reply's tokens. */
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface JsonCompletionProvider {
  /** Recorded with each generation, e.g. "openai". */
  readonly name: string;
  readonly model: string;
  /** Returns the reply text, which the caller parses as JSON. */
  complete(request: CompletionRequest): Promise<{ text: string; usage: Usage }>;
}

/**
 * A provider failure with a storable code. Retryable failures (rate limits,
 * outages, timeouts) are retried by the job; the rest end the generation.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly usage: Usage = { inputTokens: 0, outputTokens: 0 },
  ) {
    super(code);
    this.name = "ProviderError";
  }
}

/** Maps an HTTP status from a provider API to a ProviderError. */
export function errorForStatus(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("provider_auth", false);
  if (status === 404) return new ProviderError("provider_model_not_found", false);
  if (status === 408 || status === 409 || status === 429) return new ProviderError(status === 429 ? "provider_rate_limited" : "provider_unavailable", true);
  if (status >= 500) return new ProviderError("provider_unavailable", true);
  return new ProviderError("provider_rejected", false);
}

/** fetch with the request's signal; network failures and timeouts become retryable ProviderErrors. */
export async function providerFetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    // The error itself can quote the URL or headers; only the kind is kept.
    if (init.signal.aborted) throw new ProviderError("provider_timeout", true);
    throw new ProviderError("provider_unreachable", true);
  }
}
