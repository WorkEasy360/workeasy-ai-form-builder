/**
 * @workeasy/ai
 *
 * AI authoring (docs/03 §4) and the console assistant (docs/09): provider adapters (OpenAI, Gemini and a local
 * stub), the prompt template, strict normalization and validation of model
 * output, and the durable `ai.generate` job. Server only: provider keys and
 * prompts never reach a browser bundle. Model output becomes a validated
 * proposal or a failure, never a change to a draft.
 */
export { AI_PROVIDERS, providerFromSettings, type AiProviderName, type AiSettings } from "./config.js";
export {
  ASSISTANT_ACTIONS,
  ASSISTANT_PAGES,
  ASSISTANT_PROMPT,
  ASSISTANT_TOOLS,
  ASSISTANT_TURN_MS,
  assistantCapabilities,
  assistantSystem,
  FORM_TABS,
  MAX_TOOL_CALLS,
  parseAssistantReply,
  runAssistantTurn,
  type AssistantContext,
  type AssistantMessage,
  type AssistantReply,
  type AssistantTurn,
  type FormTab,
  type Navigation,
  type ProposedAction,
} from "./assistant.js";
export { generateProposal, MAX_OUTPUT_TOKENS, PROVIDER_TIMEOUT_MS, reservationTokens, type GenerationResult } from "./generate.js";
export { geminiProvider } from "./gemini.js";
export { AI_DEADLINE_SECONDS, AI_GENERATE_JOB, AI_GENERATE_MAX_ATTEMPTS, aiGenerationJob, type AiJobDeps } from "./job.js";
export { proposalFromReply, type ProposalResult, type ProposalSummary } from "./normalize.js";
export { openAiProvider } from "./openai.js";
export { AI_LIMITS, MAX_PROMPT_CHARS, TEMPLATE_VERSION, type GenerationRequest } from "./prompt.js";
export { errorForStatus, ProviderError, type CompletionRequest, type JsonCompletionProvider, type Usage } from "./provider.js";
export { stubProvider } from "./stub.js";
