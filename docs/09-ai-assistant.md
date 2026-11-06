# 09 · AI assistant

The console has a forms assistant: a round chat button floating in the bottom-right corner of every organization page. It follows the suite blueprint, [docs/shared/ai-assistant-blueprint.md](shared/ai-assistant-blueprint.md); this page lists what is specific to the form builder.

- **Desktop and tablet:** it opens a chat window just above the button. The window doesn't block the page, so the console stays visible and usable.
- **Phones:** the chat takes the whole screen, with a close button in its header.
- **Keyboard:** Escape closes the chat, and focus returns to the button.

The chat window is `apps/console/src/app/o/[orgId]/assistant-panel.tsx`, styled by the shared `.c-fab` and `.c-chatbox`. Members can ask about their forms, response counts, analytics, failed deliveries and recent changes, find pages, and have routine form changes prepared for them to confirm.

The prompt is `ASSISTANT_PROMPT` in `packages/ai/src/assistant.ts`, written in the blueprint's ten sections. Its form-builder rules: only a person publishes; the assistant never sees respondents' answers; analytics days are UTC.

## How it works

1. The member asks a question. The API (`POST /api/v1/organizations/:orgId/assistant`) checks they are an active member, that the organization has turned AI on, and takes one question from the organization's daily allowance.
2. The model receives the prompt plus a context block: organization, member, role, today's date (UTC), and only the tools, actions and pages that role may use.
3. The model replies in the blueprint's JSON format: a **read-only tool** or an **answer**. It may use up to 4 tools per question.
4. Each tool runs in its own short transaction, scoped to the organization by row-level security. The member's organization permissions are checked again on every call, and tools about one form check the member's access to that form, exactly as the form's own pages do.
5. An answer can include a **link** (a page, or one tab of a form as `<tab>:<form id>`) and a **proposed action**. The server resolves both against the organization as it is now: a link the member can't open is dropped, and an action is checked against the form or job and the member's access, using the same body schema as its endpoint.
6. Nothing changes until the member presses the card's button. The console then calls the **existing endpoint**, the same one its own page uses, which validates, audits and reports the real result.

## Respondent data

The assistant never reads responses. No tool queries submissions or their answers: tools return form metadata (names, states, question labels and types, settings) and counts. This keeps the default AI data policy in docs/08 ("no respondent content") and the authoring boundary in docs/03 §4. Response counts appear only for forms whose responses the member may read, as on the Forms page.

## Tools (read-only)

| Tool | Needs | Returns |
|---|---|---|
| `organization_overview` | any member | Organization name, the member's role, today (UTC), form counts by state among forms they can see, active members (with `members.manage`), whether AI is on, and today's AI use |
| `search_forms` | any member; lists only forms they can see | Id, state, whether it's live, response count and last response (only where they may read responses), and what they may do |
| `get_form` | access to the form | State, live version, public link, pages and question labels and types, who can respond, response limit, open and close dates, response count (if readable) |
| `form_analytics` | `analytics.read` on the form | Views, starts and accepted responses for 7, 30 or 90 UTC days, with rates and the definitions the Analytics tab shows |
| `form_integrations` | `integrations.manage` and access to the form | Each notification, confirmation email and webhook: kind, name, on or off. Never URLs, recipients or secrets |
| `failed_jobs` | `organization.audit.read` | Jobs that stopped retrying: type, attempts, error code, when |
| `list_members` | `members.manage` | Name, role and status, and how many invitations are pending. Never email addresses |
| `recent_activity` | `organization.audit.read` | Latest audit entries: action, form name, actor, time. Never the entries' metadata |

## Actions (confirmed by the member)

| Action | Allowed when | Endpoint |
|---|---|---|
| `create_form` | `forms.create`. Blank or from a built-in template; name checked with the Create form schema | `POST …/forms` |
| `duplicate_form` | `forms.create` and `forms.edit` on the source form | `POST …/forms/:id/duplicate` |
| `close_form` | `forms.publish` on the form, and the form is published. Shown as a red (danger) card because it stops respondents at once | `POST …/forms/:id/close` |
| `reopen_form` | `forms.publish` on the form, and the form is closed | `POST …/forms/:id/reopen` |
| `retry_job` | `integrations.manage`, and the job is dead | `POST …/jobs/:id/replay` |

Left out on purpose: publishing (a person publishes, docs/03 §4), deleting forms or responses (irreversible), exports (they produce files), and editing questions, design, logic, access, limits, retention, integrations and members (rich editing). For those the assistant explains the steps and links to the right page.

## Safety

- **Organization isolation** comes from the database (row-level security) and the membership check, not from the prompt. Members of other organizations get 404.
- **Opt-in.** The assistant sends organization data to the AI provider, so it works only when an owner has turned AI on in AI settings, the same switch as AI drafting.
- **The model cannot write.** It has no write tools, and its actions are only suggestions. Forged chat history doesn't help an attacker: every tool and endpoint checks the signed-in member.
- **Tool results are data.** Form names, question labels and reasons are marked as data, and the model is told never to follow instructions found inside them.
- **Replies are checked.** Every reply is validated against the JSON format. A malformed reply gets one correction, and a second ends the question with an error. Links outside the page list and unknown actions are dropped.
- **What's logged:** tools used, success or failure, and token counts. Questions, answers and tool data are not logged. Confirmed actions appear in the audit log through their endpoints.
- **The chat history** stays in the browser tab (session storage). The server stores no conversations.

## Settings and limits

The API calls the provider itself, because the member is waiting for the answer; the worker still runs AI drafting. Both read the same settings, which production keeps in one `.env` for every container:

| Setting | Meaning |
|---|---|
| `AI_PROVIDER` | `gemini`, `openai`, `stub` (local, deterministic, for development and tests) or `disabled` (the panel then says the assistant isn't set up) |
| `AI_MODEL`, `GEMINI_API_KEY` / `OPENAI_API_KEY` | Required for a real provider. The API refuses to start without them |
| `ASSISTANT_DAILY_LIMIT` | Questions per organization per UTC day (default 200), counted in `ai_usage_days.assistant_messages` |

A question also counts against the organization's **daily token limit** from AI settings, shared with AI drafting: it starts only while the day's tokens have room, and its actual tokens are added to `used_tokens`.

Limits on one question: 4 tools and 50 seconds at most, replies capped at 1,500 tokens, the last 12 messages of history sent, and a question of up to 2,000 characters.
