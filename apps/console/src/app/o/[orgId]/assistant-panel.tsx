"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AgentAvatar, ArrowRightIcon, CloseIcon } from "@workeasy/ui/react";
import { api, ApiError } from "../../../lib/api";

interface Proposal {
  kind: string;
  title: string;
  summary: Array<[string, string]>;
  effect: string;
  confirmLabel: string;
  danger: boolean;
  request: { method: "POST" | "PUT"; path: string; body: Record<string, unknown> };
  /** Where the result lives once it's done; `:id` comes from the response's form. */
  done?: { label: string; path: string; idFrom?: "form" };
}

interface Message {
  role: "user" | "assistant";
  content: string;
  link?: { label: string; href: string } | null;
  proposal?: Proposal | null;
  /** Why a requested change can't be offered (wrong state, role…). */
  note?: string | null;
  /** What happened to the proposal: confirmed (with the server's answer), declined or failed. */
  outcome?: { kind: "done" | "declined" | "failed"; text: string; link?: { label: string; href: string } };
  error?: boolean;
}

interface AskResponse {
  answer: { text: string; link: { label: string; href: string } | null; proposal: Proposal | null; note: string | null };
  usedToday: number;
  dailyLimit: number;
}

interface Status {
  enabled: boolean;
  /** "server": AI isn't set up on this installation. AI is always on for organizations. */
  disabledBy?: "server";
  usedToday: number;
  dailyLimit: number;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong. Try again.";
}

const storageKey = (orgId: string) => `we-assistant:${orgId}`;

function load(orgId: string): Message[] {
  try {
    const raw = sessionStorage.getItem(storageKey(orgId));
    const parsed = raw ? (JSON.parse(raw) as Message[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch {
    return [];
  }
}

function save(orgId: string, messages: Message[]) {
  try {
    sessionStorage.setItem(storageKey(orgId), JSON.stringify(messages.slice(-40)));
  } catch {
    // Storage can be unavailable (private windows); the chat then lasts for this page only.
  }
}

/** Questions to start from, shown only when the member's role can answer them. */
const SUGGESTIONS: ReadonlyArray<{ text: string; permission: string | null }> = [
  { text: "Which forms got responses this week?", permission: null },
  { text: "How are my live forms doing?", permission: null },
  { text: "Did any webhook or email delivery fail?", permission: "integrations.manage" },
  { text: "Create a feedback form for me", permission: "forms.create" },
  { text: "Who changed what recently?", permission: "organization.audit.read" },
  { text: "Take me to members", permission: "members.manage" },
];

/**
 * The forms assistant: a floating chat button in the bottom-right corner
 * that opens a chat window above it (full screen on phones). The window
 * doesn't block the page, so the console stays usable. Answers come from the
 * API, which reads this organization's data as the signed-in member and
 * never sees respondents' answers. A proposed change shows as a card;
 * nothing happens until the member confirms, and then the same endpoint as
 * the console's own page carries it out.
 */
export function AssistantPanel({ orgId, can, userName }: { orgId: string; can: (permission: string) => boolean; userName: string }) {
  const [open, setOpen] = useState(false);
  // Pages are full loads, so the chat is kept per tab and follows the member around the console.
  const [messages, setMessages] = useState<Message[]>(() => load(orgId));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | undefined>();
  const inputId = useId();
  const titleId = useId();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Keeps the newest message in view after every render while the window is open.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  });
  // Focus moves into the window when it opens and back to the button when it closes.
  useEffect(() => {
    if (open) (inputRef.current ?? closeRef.current)?.focus();
    else if (wasOpen.current) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open || status) return;
    api<Status>(`/api/v1/organizations/${orgId}/assistant`)
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, disabledBy: "server", usedToday: 0, dailyLimit: 0 }));
  }, [open, status, orgId]);

  const update = (next: Message[]) => {
    setMessages(next);
    save(orgId, next);
  };

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    const withQuestion: Message[] = [...messages, { role: "user", content: q }];
    update(withQuestion);
    setDraft("");
    setBusy(true);
    try {
      const r = await api<AskResponse>(`/api/v1/organizations/${orgId}/assistant`, { method: "POST", body: { question: q, history } });
      setStatus({ enabled: true, usedToday: r.usedToday, dailyLimit: r.dailyLimit });
      update([...withQuestion, { role: "assistant", content: r.answer.text, link: r.answer.link, proposal: r.answer.proposal, note: r.answer.note }]);
    } catch (err) {
      update([...withQuestion, { role: "assistant", content: errorText(err), error: true }]);
    } finally {
      setBusy(false);
    }
  }

  /** Carries out a confirmed proposal through its endpoint and reports what the server said. */
  async function decide(index: number, confirm: boolean) {
    const m = messages[index];
    if (!m?.proposal || m.outcome) return;
    if (!confirm) {
      update(messages.map((x, i) => (i === index ? { ...x, outcome: { kind: "declined", text: "Not done. Nothing was changed." } } : x)));
      return;
    }
    setBusy(true);
    let outcome: Message["outcome"];
    try {
      const result = await api<{ form?: { id?: string } }>(m.proposal.request.path, { method: m.proposal.request.method, body: m.proposal.request.body });
      const done = m.proposal.done;
      const id = done?.idFrom ? result[done.idFrom]?.id : undefined;
      const link = done && (!done.idFrom || id) ? { label: done.label, href: `/o/${orgId}${done.path.replace(":id", id ?? "")}` } : undefined;
      outcome = { kind: "done", text: `Done: ${m.proposal.title.charAt(0).toLowerCase()}${m.proposal.title.slice(1)}.`, ...(link ? { link } : {}) };
    } catch (err) {
      outcome = { kind: "failed", text: `Not done: ${errorText(err)}` };
    } finally {
      setBusy(false);
    }
    // Recorded as a message too, so the assistant knows what happened next time.
    update([...messages.map((x, i) => (i === index ? { ...x, outcome } : x)), { role: "assistant", content: outcome.text, link: outcome.link ?? null }]);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  // The shell says "Your account" when someone has no display name.
  const firstName = userName && userName !== "Your account" ? (userName.trim().split(/\s+/)[0] ?? "there") : "there";
  const suggestions = SUGGESTIONS.filter((s) => !s.permission || can(s.permission)).slice(0, 4);
  const disabled = status?.enabled === false;
  const left = status && status.enabled ? Math.max(0, status.dailyLimit - status.usedToday) : undefined;

  return (
    <>
      {open && (
        <section
          className="c-chatbox"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <header className="c-chatbox-head">
            <span className="c-agent c-agent-md">
              <AgentAvatar size={28} />
            </span>
            <div>
              <h2 id={titleId}>Workeasy assistant</h2>
              <small>Answers from this organization&apos;s live data</small>
            </div>
            <button ref={closeRef} type="button" className="c-btn c-btn-ghost c-btn-icon" aria-label="Close assistant" onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </header>
          <div className="c-chat">
            <div className="c-chat-log" aria-live="polite" aria-busy={busy}>
              {messages.length === 0 && (
                <div className="c-chat-intro">
                  <span className="c-agent c-agent-lg">
                    <AgentAvatar size={56} />
                  </span>
                  <p className="c-chat-hello">Hi {firstName}, I&apos;m your forms assistant.</p>
                  <p>
                    Ask about your forms, response counts, analytics, deliveries and who changed what, or where to find something. I can&apos;t see what respondents answered, and I
                    only change something after you confirm it.
                  </p>
                  {!disabled && (
                    <div className="c-chat-suggest">
                      {suggestions.map((s) => (
                        <button key={s.text} type="button" className="c-btn c-btn-sm" onClick={() => void ask(s.text)} disabled={busy}>
                          {s.text}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className="c-msg-row" data-role={m.role}>
                  {m.role === "assistant" && (
                    <span className="c-agent c-agent-sm">
                      <AgentAvatar size={22} />
                    </span>
                  )}
                  <div className="c-msg" data-role={m.role} data-error={m.error ? "true" : undefined}>
                    <span className="c-visually-hidden">{m.role === "user" ? "You:" : "Assistant:"}</span>
                    <p>{m.content}</p>
                    {m.note && <p className="c-msg-note">{m.note}</p>}
                    {m.link && (
                      <a className="c-btn c-btn-sm" href={m.link.href}>
                        Open {m.link.label} <ArrowRightIcon size={14} />
                      </a>
                    )}
                    {m.proposal && (
                      <section className="c-proposal" data-danger={m.proposal.danger ? "true" : undefined} aria-label={m.proposal.title}>
                        <strong>{m.proposal.title}</strong>
                        <dl className="c-kv">
                          {m.proposal.summary.map(([k, v]) => (
                            <div key={k} style={{ display: "contents" }}>
                              <dt>{k}</dt>
                              <dd>{v}</dd>
                            </div>
                          ))}
                        </dl>
                        <p className="c-hint">{m.proposal.effect}</p>
                        {m.outcome ? (
                          <p className={m.outcome.kind === "done" ? "c-ok" : m.outcome.kind === "failed" ? "c-error" : "c-hint"}>{m.outcome.text}</p>
                        ) : (
                          <div className="c-proposal-actions">
                            <button type="button" className={m.proposal.danger ? "c-btn c-btn-sm c-btn-danger" : "c-btn c-btn-sm c-btn-primary"} disabled={busy} onClick={() => void decide(i, true)}>
                              {m.proposal.confirmLabel}
                            </button>
                            <button type="button" className="c-btn c-btn-sm c-btn-ghost" disabled={busy} onClick={() => void decide(i, false)}>
                              Not now
                            </button>
                          </div>
                        )}
                      </section>
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="c-msg-row" data-role="assistant" role="status">
                  <span className="c-agent c-agent-sm">
                    <AgentAvatar size={22} />
                  </span>
                  <span className="c-chat-busy">
                    <span className="c-typing" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="c-visually-hidden">Working on it…</span>
                  </span>
                </div>
              )}
              <div ref={endRef} />
            </div>
            {disabled ? (
              <p className="c-alert" data-tone="info">
                The assistant isn&apos;t set up on this server yet. Ask whoever runs your Workeasy installation to turn on AI.
              </p>
            ) : (
              <form className="c-chat-form" onSubmit={submit}>
                <label htmlFor={inputId} className="c-visually-hidden">
                  Ask the assistant
                </label>
                <textarea
                  ref={inputRef}
                  id={inputId}
                  className="c-textarea"
                  rows={2}
                  maxLength={2000}
                  placeholder="Ask anything about your forms…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void ask(draft);
                    }
                  }}
                />
                <div className="c-chat-foot">
                  <span className="c-hint">
                    {left !== undefined ? `${left} question${left === 1 ? "" : "s"} left today` : ""}
                    {left !== undefined && messages.length > 0 ? " · " : ""}
                    {messages.length > 0 && (
                      <button type="button" className="c-link-btn" onClick={() => update([])}>
                        Clear chat
                      </button>
                    )}
                  </span>
                  <button type="submit" className="c-btn c-btn-primary c-btn-sm" disabled={busy || !draft.trim()}>
                    Send
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      )}
      <button
        ref={launcherRef}
        type="button"
        className="c-fab"
        data-open={open ? "true" : undefined}
        aria-label={open ? "Close AI assistant" : "Open AI assistant"}
        aria-expanded={open}
        title={open ? "Close AI assistant" : "Ask AI"}
        onClick={() => setOpen(!open)}
      >
        {open ? <CloseIcon size={22} /> : <AgentAvatar size={38} />}
      </button>
    </>
  );
}
