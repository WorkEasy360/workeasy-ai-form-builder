import { describe, expect, it } from "vitest";
import { assistantCapabilities, assistantSystem, MAX_TOOL_CALLS, parseAssistantReply, runAssistantTurn } from "./assistant.js";
import { ProviderError, type CompletionRequest, type JsonCompletionProvider } from "./provider.js";

const signal = new AbortController().signal;
const FORM = "0193a2b4-1c2d-7e8f-9a0b-1c2d3e4f5a6b";

/** A provider that replies from a script, one reply per call, and records what it was sent. */
function scripted(replies: string[]) {
  const calls: CompletionRequest[] = [];
  const provider: JsonCompletionProvider = {
    name: "scripted",
    model: "test",
    complete(request) {
      calls.push(request);
      const text = replies.shift();
      if (text === undefined) throw new ProviderError("provider_unavailable", true);
      return Promise.resolve({ text, usage: { inputTokens: 10, outputTokens: 5 } });
    },
  };
  return { provider, calls };
}

const answer = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "answer", text, navigate: null, action: null, ...extra });
const tool = (name: string, args: Record<string, unknown> = {}) => JSON.stringify({ type: "tool", tool: name, args });

describe("replies", () => {
  it("accepts tool calls and answers, and drops malformed extras", () => {
    expect(parseAssistantReply(tool("get_form", { id: FORM }))).toEqual({ type: "tool", tool: "get_form", args: { id: FORM } });
    expect(parseAssistantReply("```json\n" + answer("Hi") + "\n```")).toMatchObject({ type: "answer", text: "Hi" });
    expect(parseAssistantReply(answer("Open it", { navigate: `responses:${FORM}` }))).toMatchObject({ navigate: { form: FORM, tab: "responses" } });
    expect(parseAssistantReply(answer("Open it", { navigate: `form:${FORM.toUpperCase()}` }))).toMatchObject({ navigate: { form: FORM, tab: "build" } });
    expect(parseAssistantReply(answer("Open it", { navigate: "members" }))).toMatchObject({ navigate: { page: "members" } });
    expect(parseAssistantReply(answer("Open it", { navigate: "https://evil.example" }))).toMatchObject({ navigate: null });
    expect(parseAssistantReply(answer("Open it", { navigate: "submissions:not-a-uuid" }))).toMatchObject({ navigate: null });
    expect(parseAssistantReply(answer("Publish", { action: { kind: "publish_form", formId: FORM } }))).toMatchObject({ action: null });
  });

  it("reads form and job tasks, keeping only known fields", () => {
    expect(parseAssistantReply(answer("Creating", { action: { kind: "create_form", name: "  Feedback  ", template: "feedback", evil: "x" } }))).toMatchObject({
      action: { kind: "create_form", name: "Feedback", template: "feedback" },
    });
    // An unknown template means a blank form; a form needs a name.
    expect(parseAssistantReply(answer("Creating", { action: { kind: "create_form", name: "Survey", template: "../../etc" } }))).toMatchObject({ action: { template: null } });
    expect(parseAssistantReply(answer("Creating", { action: { kind: "create_form" } }))).toMatchObject({ action: null });
    expect(parseAssistantReply(answer("Copying", { action: { kind: "duplicate_form", formId: FORM, name: "Copy" } }))).toMatchObject({ action: { kind: "duplicate_form", formId: FORM, name: "Copy" } });
    expect(parseAssistantReply(answer("Copying", { action: { kind: "duplicate_form", formId: FORM } }))).toMatchObject({ action: null });
    expect(parseAssistantReply(answer("Closing", { action: { kind: "close_form", formId: FORM, reason: "x".repeat(900) } }))).toMatchObject({ action: { kind: "close_form", reason: "x".repeat(500) } });
    expect(parseAssistantReply(answer("Closing", { action: { kind: "close_form", formId: "42" } }))).toMatchObject({ action: null });
    expect(parseAssistantReply(answer("Retrying", { action: { kind: "retry_job", jobId: FORM } }))).toMatchObject({ action: { kind: "retry_job", jobId: FORM } });
  });

  it("strips markdown the chat can't show", () => {
    expect(parseAssistantReply(answer("## Steps\n1. Open **Forms** and choose `Create form`.\n* Then __Publish__."))).toMatchObject({
      text: "Steps\n1. Open Forms and choose Create form.\n- Then Publish.",
    });
  });

  it("rejects anything outside the protocol", () => {
    expect(parseAssistantReply("Sure! Here's the answer")).toBeUndefined();
    expect(parseAssistantReply(JSON.stringify({ type: "answer", text: "" }))).toBeUndefined();
    expect(parseAssistantReply(JSON.stringify({ type: "tool", tool: "DROP TABLE" }))).toBeUndefined();
    expect(parseAssistantReply(JSON.stringify({ type: "tool", tool: "search_forms", args: { query: "x".repeat(3000) } }))).toBeUndefined();
  });
});

describe("capabilities", () => {
  it("lists only what the member's role allows", () => {
    // An analyst holds no organization permissions: form tools only, no organization actions.
    const analyst = assistantCapabilities(new Set());
    expect(analyst.tools.map((t) => t.name)).toEqual(["organization_overview", "search_forms", "get_form", "form_analytics"]);
    expect(analyst.actions.map((a) => a.kind)).toEqual(["close_form", "reopen_form"]);
    expect(analyst.pages.map((p) => p.key)).toEqual(["forms", "help"]);
    const admin = assistantCapabilities(new Set(["members.manage", "integrations.manage", "forms.create", "organization.audit.read"]));
    expect(admin.tools.map((t) => t.name)).toContain("failed_jobs");
    expect(admin.actions.map((a) => a.kind)).toContain("retry_job");
    const system = assistantSystem({ organizationName: "Acme Support", role: "analyst", memberName: "Ana", today: "2026-11-06", permissions: new Set() });
    expect(system).toContain("Organization: Acme Support");
    expect(system).toContain("Today (UTC): 2026-11-06.");
    expect(system).not.toContain("- list_members");
    expect(system).not.toContain("- create_form");
  });
});

describe("the loop", () => {
  const input = { system: "test", history: [], question: "How many forms are live?" };

  it("runs tools, feeds results back and returns the answer", async () => {
    const { provider, calls } = scripted([tool("organization_overview"), answer("You have 2 live forms.")]);
    const ran: string[] = [];
    const turn = await runAssistantTurn(provider, input, (name) => (ran.push(name), Promise.resolve({ ok: true, result: { published: 2 } })), signal);
    expect(turn).toMatchObject({ ok: true, answer: { text: "You have 2 live forms." }, tools: [{ tool: "organization_overview", ok: true }], usage: { inputTokens: 20, outputTokens: 10 } });
    expect(ran).toEqual(["organization_overview"]);
    expect(calls[1]!.messages.at(-1)!.content).toBe('<tool_result name="organization_overview">\n{"published":2}\n</tool_result>');
  });

  it("stops tool use after the limit and asks for an answer", async () => {
    const { provider, calls } = scripted([...Array.from({ length: MAX_TOOL_CALLS + 1 }, () => tool("search_forms")), answer("Done.")]);
    const turn = await runAssistantTurn(provider, input, () => Promise.resolve({ ok: true, result: {} }), signal);
    expect(turn).toMatchObject({ ok: true, answer: { text: "Done." } });
    expect(turn.tools).toHaveLength(MAX_TOOL_CALLS);
    expect(calls.at(-1)!.messages.at(-1)!.content).toMatch(/used all your tools/);
  });

  it("corrects one invalid reply, then gives up", async () => {
    expect(await runAssistantTurn(scripted(["not json", answer("Fixed.")]).provider, input, () => Promise.resolve({ ok: true, result: {} }), signal)).toMatchObject({ ok: true, answer: { text: "Fixed." } });
    expect(await runAssistantTurn(scripted(["not json", "still not"]).provider, input, () => Promise.resolve({ ok: true, result: {} }), signal)).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("reports provider failures with their code", async () => {
    expect(await runAssistantTurn(scripted([]).provider, input, () => Promise.resolve({ ok: true, result: {} }), signal)).toMatchObject({ ok: false, code: "provider_unavailable" });
  });
});
