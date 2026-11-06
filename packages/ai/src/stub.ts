import type { CompletionRequest, JsonCompletionProvider } from "./provider.js";

/**
 * A deterministic local provider for development and CI, so AI flows work
 * without a provider account. It builds a plausible form from keywords in
 * the request (or adds a comments field when editing), and plays the
 * console assistant well enough to exercise its loop. It is not a model.
 */
export function stubProvider(): JsonCompletionProvider {
  return {
    name: "stub",
    model: "stub-1",
    complete(request: CompletionRequest) {
      if (request.system.startsWith("# Workeasy AI Form Builder assistant")) return Promise.resolve(stubAssistant(request));
      const first = request.messages[0]?.content ?? "";
      const asked = /<request>\n([\s\S]*)\n<\/request>/.exec(first)?.[1] ?? "";
      const words = asked.toLowerCase();
      const current = /Current form:\n\n(\{[\s\S]*\})\n\n<request>/.exec(first)?.[1];
      let form: Record<string, unknown>;
      if (current) {
        form = JSON.parse(current) as Record<string, unknown>;
        const fields = form.fields as Array<Record<string, unknown>>;
        const pages = form.pages as Array<{ fieldIds: string[] }>;
        fields.push({ id: "comments", type: "textarea", label: "Anything else?", required: false, settings: { maxLength: 2000 } });
        pages[pages.length - 1]!.fieldIds.push("comments");
      } else {
        const fields: Array<Record<string, unknown>> = [
          { id: "name", type: "text", label: "Full name", required: true, privacy: "personal", settings: { maxLength: 200 } },
          { id: "email", type: "email", label: "Email address", required: true, privacy: "personal", settings: {} },
        ];
        if (/phone|call/.test(words)) fields.push({ id: "phone", type: "phone", label: "Phone number", required: false, privacy: "personal", settings: {} });
        if (/date|event|book|appointment/.test(words)) fields.push({ id: "date", type: "date", label: "Preferred date", required: false, settings: {} });
        if (/feedback|rating|survey|satisf/.test(words)) fields.push({ id: "rating", type: "rating", label: "How would you rate it?", required: true, settings: { min: 1, max: 5 } });
        fields.push({ id: "message", type: "textarea", label: "Message", required: false, settings: { maxLength: 2000 } });
        const title = asked.trim().split(/[.\n]/)[0]!.slice(0, 80) || "New form";
        form = {
          title: title.charAt(0).toUpperCase() + title.slice(1),
          pages: [{ id: "main", title: "", fieldIds: fields.map((f) => f.id) }],
          fields,
          rules: [],
          success: { message: "Thank you. Your response has been recorded." },
        };
      }
      const text = JSON.stringify(form);
      return Promise.resolve({ text, usage: { inputTokens: Math.ceil((request.system.length + first.length) / 4), outputTokens: Math.ceil(text.length / 4) } });
    },
  };
}

/**
 * The assistant's side of the stub: routes a question to one tool by its
 * words, then answers with what the tool returned, and turns a few phrasings
 * into navigation and proposals. Enough to exercise the whole loop (tools,
 * links, proposals) without a model.
 */
function stubAssistant(request: CompletionRequest): { text: string; usage: { inputTokens: number; outputTokens: number } } {
  const last = request.messages.at(-1)?.content ?? "";
  const original = request.messages.findLast((m) => m.role === "user" && !m.content.startsWith("<tool_result"))?.content ?? "";
  const question = original.toLowerCase();
  const tools = new Set([...request.system.matchAll(/^- ([a-z_]+) [{]/gm)].map((m) => m[1]));
  const id = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(question)?.[1];
  const quoted = /"([^"]+)"/.exec(original)?.[1];
  let out: unknown;
  const result = /^<tool_result name="([a-z_]+)">\n([\s\S]*)\n<\/tool_result>$/.exec(last);
  if (result) {
    const [, tool, body] = result;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(body!) as Record<string, unknown>;
    } catch {
      // Truncated results are summarised without their contents.
    }
    const items = Array.isArray(data.items) ? data.items.length : undefined;
    out = data.error
      ? { type: "answer", text: `I couldn't get that: ${String(data.error)}`, navigate: null, action: null }
      : { type: "answer", text: items === undefined ? `Here's what I found (${tool}).` : `I found ${items} result${items === 1 ? "" : "s"} (${tool}).`, navigate: null, action: null };
  } else if (/\b(close|reopen)\b/.test(question) && id) {
    const kind = /\breopen\b/.test(question) ? "reopen_form" : "close_form";
    out = { type: "answer", text: kind === "close_form" ? "I'll close that form. Confirm below." : "I'll reopen that form. Confirm below.", navigate: null, action: { kind, formId: id } };
  } else if (/\b(copy|duplicate)\b/.test(question) && id && quoted) {
    out = { type: "answer", text: `I'll copy it as ${quoted}.`, navigate: null, action: { kind: "duplicate_form", formId: id, name: quoted } };
  } else if (/\bretry\b/.test(question) && id) {
    out = { type: "answer", text: "I'll retry that job.", navigate: null, action: { kind: "retry_job", jobId: id } };
  } else if (/\b(create|new)\b.*\bform\b/.test(question) && quoted) {
    const template = ["contact", "support-request", "feedback"].find((t) => question.includes(t.replace("-", " ")));
    out = { type: "answer", text: `I'll create ${quoted}.`, navigate: null, action: { kind: "create_form", name: quoted, ...(template ? { template } : {}) } };
  } else if (/\b(open|go to|take me)\b/.test(question)) {
    const tab = id ? (["responses", "analytics", "integrations", "settings"].find((t) => question.includes(t)) ?? "build") : undefined;
    const page = ["members", "audit", "jobs", "help"].find((p) => question.includes(p)) ?? "forms";
    out = { type: "answer", text: "Opening it.", navigate: tab ? `${tab}:${id}` : page, action: null };
  } else {
    const route: Array<[RegExp, string, Record<string, unknown>]> = [
      [/\b(analytics|views|doing)\b/, id ? "form_analytics" : "search_forms", id ? { id, days: 30 } : {}],
      [/\b(failed|webhook|jobs?)\b/, "failed_jobs", {}],
      [/\b(members?|team)\b/, "list_members", {}],
      [/\b(activity|audit|changed)\b/, "recent_activity", {}],
      [/\b(overview|how many)\b/, "organization_overview", {}],
      [/\bforms?\b/, id ? "get_form" : "search_forms", id ? { id } : {}],
    ];
    const hit = route.find(([re, tool]) => re.test(question) && tools.has(tool));
    out = hit
      ? { type: "tool", tool: hit[1], args: hit[2] }
      : { type: "answer", text: "I can look up your forms, response counts, analytics and more. What would you like to know?", navigate: null, action: null };
  }
  const text = JSON.stringify(out);
  return { text, usage: { inputTokens: Math.ceil((request.system.length + last.length) / 4), outputTokens: Math.ceil(text.length / 4) } };
}
