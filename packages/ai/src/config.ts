import { geminiProvider } from "./gemini.js";
import { openAiProvider } from "./openai.js";
import type { JsonCompletionProvider } from "./provider.js";
import { stubProvider } from "./stub.js";

export const AI_PROVIDERS = ["disabled", "stub", "openai", "gemini"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface AiSettings {
  AI_PROVIDER?: AiProviderName | undefined;
  AI_MODEL?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
}

/**
 * The configured provider, or undefined when AI is disabled. Real providers
 * need a model and their API key; missing settings are a startup error, not
 * a failure discovered on the first request.
 */
export function providerFromSettings(settings: AiSettings): JsonCompletionProvider | undefined {
  const name = settings.AI_PROVIDER ?? "disabled";
  if (name === "disabled") return undefined;
  if (name === "stub") return stubProvider();
  if (!settings.AI_MODEL) throw new Error(`AI_PROVIDER=${name} needs AI_MODEL`);
  if (name === "openai") {
    if (!settings.OPENAI_API_KEY) throw new Error("AI_PROVIDER=openai needs OPENAI_API_KEY");
    return openAiProvider({ apiKey: settings.OPENAI_API_KEY, model: settings.AI_MODEL });
  }
  if (!settings.GEMINI_API_KEY) throw new Error("AI_PROVIDER=gemini needs GEMINI_API_KEY");
  return geminiProvider({ apiKey: settings.GEMINI_API_KEY, model: settings.AI_MODEL });
}
