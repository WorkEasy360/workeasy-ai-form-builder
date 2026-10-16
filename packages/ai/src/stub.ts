import type { CompletionRequest, JsonCompletionProvider } from "./provider.js";

/**
 * A deterministic local provider for development and CI, so AI flows work
 * without a provider account. It builds a plausible form from keywords in
 * the request (or adds a comments field when editing). It is not a model.
 */
export function stubProvider(): JsonCompletionProvider {
  return {
    name: "stub",
    model: "stub-1",
    complete(request: CompletionRequest) {
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
