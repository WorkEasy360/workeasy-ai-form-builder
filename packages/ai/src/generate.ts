import type { DefinitionIssue, FormDefinition } from "@workeasy/form-schema";
import { proposalFromReply, type ProposalSummary } from "./normalize.js";
import { repairMessage, requestMessage, systemPrompt, type GenerationRequest } from "./prompt.js";
import { ProviderError, type JsonCompletionProvider, type Usage } from "./provider.js";

/** One provider call may take this long (docs/03 §4). */
export const PROVIDER_TIMEOUT_MS = 45_000;
export const MAX_OUTPUT_TOKENS = 16_000;
const CALLS = 2;

/**
 * The most tokens a generation can spend, reserved against the daily budget
 * before it is queued (docs/03 §4): two calls (the request and one repair),
 * each with the whole conversation as input and the maximum output. Inputs
 * are estimated at one token per three characters, which overestimates for
 * typical text. The repair call also resends the first reply.
 */
export function reservationTokens(request: GenerationRequest): number {
  const inputChars = systemPrompt().length + requestMessage(request).length;
  const perCallInput = Math.ceil(inputChars / 3) + MAX_OUTPUT_TOKENS;
  return CALLS * (perCallInput + MAX_OUTPUT_TOKENS);
}

export type GenerationResult =
  | { ok: true; definition: FormDefinition; summary: ProposalSummary; usage: Usage }
  | { ok: false; code: "invalid_output"; issues: DefinitionIssue[]; usage: Usage };

const sum = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });

/**
 * Asks the provider for a form and validates the reply. An invalid reply gets
 * one repair attempt with the problems listed; if that is invalid too, the
 * result is a failure with the issues, never a partial form. Provider
 * failures throw ProviderError carrying the usage spent so far.
 */
export async function generateProposal(provider: JsonCompletionProvider, request: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: requestMessage(request) }];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let issues: DefinitionIssue[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let reply: { text: string; usage: Usage };
    try {
      reply = await provider.complete({
        system: systemPrompt(),
        messages,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        signal: AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw new ProviderError(err.code, err.retryable, sum(usage, err.usage));
      throw err;
    }
    usage = sum(usage, reply.usage);
    const result = proposalFromReply(reply.text, request.base, request.operation);
    if (result.ok) return { ...result, usage };
    issues = result.issues;
    messages.push({ role: "assistant", content: reply.text }, { role: "user", content: repairMessage(issues) });
  }
  return { ok: false, code: "invalid_output", issues, usage };
}
