/**
 * @workeasy/ai
 *
 * AI authoring (docs/03 §4): provider adapters (OpenAI, Gemini and a local
 * stub), the prompt template, strict normalization and validation of model
 * output, and the durable `ai.generate` job. Server only: provider keys and
 * prompts never reach a browser bundle. Model output becomes a validated
 * proposal or a failure, never a change to a draft.
 */
export { AI_PROVIDERS, providerFromSettings, type AiProviderName, type AiSettings } from "./config.js";
export { generateProposal, PROVIDER_TIMEOUT_MS, type GenerationResult } from "./generate.js";
export { geminiProvider } from "./gemini.js";
export { AI_DEADLINE_SECONDS, AI_GENERATE_JOB, AI_GENERATE_MAX_ATTEMPTS, aiGenerationJob, type AiJobDeps } from "./job.js";
export { proposalFromReply, type ProposalResult, type ProposalSummary } from "./normalize.js";
export { openAiProvider } from "./openai.js";
export { AI_LIMITS, MAX_PROMPT_CHARS, TEMPLATE_VERSION, type GenerationRequest } from "./prompt.js";
export { errorForStatus, ProviderError, type CompletionRequest, type JsonCompletionProvider, type Usage } from "./provider.js";
export { stubProvider } from "./stub.js";
