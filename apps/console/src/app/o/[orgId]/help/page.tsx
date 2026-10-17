/**
 * Help for people who build forms (DOC-01): from a new form to a shared
 * link, then what happens with responses. Operators' runbook is
 * docs/operations.md; developers' is docs/api.md.
 */
const SECTIONS: Array<{ id: string; title: string; steps: string[] }> = [
  {
    id: "create",
    title: "1. Create a form",
    steps: [
      "Go to Forms and choose Create form.",
      "Name it, then choose how to start: Blank form, Template, or Describe it with AI (when your organization has turned AI on). AI only suggests; nothing changes until you apply it.",
    ],
  },
  {
    id: "build",
    title: "2. Add questions",
    steps: [
      "On the Build tab, drag a question type from the left onto the form, or select it and press Enter.",
      "Select a question to edit its label, help text, whether it is required, and its options on the right. Mark answers that are personal or sensitive so only people allowed to see them can.",
      "Add pages for long forms, and rules to show a question or skip a page depending on an earlier answer.",
      "Your work saves automatically. Undo with Ctrl+Z and redo with Ctrl+Shift+Z (Cmd on a Mac). Preview shows the form exactly as respondents will see it.",
    ],
  },
  {
    id: "publish",
    title: "3. Publish",
    steps: [
      "Open Publish. The checklist lists anything to fix first, such as a page with no questions.",
      "Publish makes the current draft the live version. Later changes stay in the draft until you publish again, so people filling in the form are never affected by half-finished edits.",
      "Version history lists every publication; you can make an earlier version live again.",
    ],
  },
  {
    id: "share",
    title: "4. Share",
    steps: [
      "Open Share for the form's link, a QR code to print, and embed code to paste into a website.",
      "Settings → Access decides who can respond: anyone with the link, or only members of your organization (they sign in first).",
      "Settings → Limits and schedule sets a maximum number of responses and opening and closing times. Settings → General closes the form at once, or reopens it.",
      "Settings → General → After submitting sets the thank-you message, or a web page to send people to.",
    ],
  },
  {
    id: "responses",
    title: "5. Read responses",
    steps: [
      "The Responses tab lists responses newest first. Filter by date, version or answer, and open one to see every answer and attached file.",
      "Export creates a spreadsheet (CSV) of the responses you are allowed to see; it appears in the list when ready, and the download link works for a limited time.",
      "Deleting a response needs a reason, hides it at once and removes its answers and files shortly after. Settings → Data retention deletes old responses automatically; a legal hold stops all deletion.",
      "The Analytics tab shows views, starts and completed responses per day.",
    ],
  },
  {
    id: "notify",
    title: "6. Get notified",
    steps: [
      "Owners and admins can add email notifications and webhooks on the Integrations tab. Emails say a response arrived and link to it, without the answers.",
      "Show deliveries lists every attempt. Failed ones say why and can be sent again.",
    ],
  },
  {
    id: "team",
    title: "7. Work with your team",
    steps: [
      "Owners and admins invite people from Members: choose a role, create a link, and send it to them. Each link works once and expires after 7 days.",
      "Roles: owners manage everything; admins manage members, integrations and every form; creators make forms and work on forms shared with them; analysts and approvers see only forms shared with them.",
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="c-page">
      <div className="c-page-head">
        <div>
          <h1>Help</h1>
          <p className="c-subtitle">From a new form to a shared link, and what happens with responses.</p>
        </div>
      </div>
      <nav aria-label="On this page" style={{ marginBottom: 24 }}>
        <ul className="c-toolbar" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a className="c-btn c-btn-sm" href={`#${s.id}`}>
                {s.title.replace(/^\d+\. /, "")}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="c-card" aria-labelledby={`${s.id}-h`}>
            <h2 id={`${s.id}-h`} style={{ fontSize: 18, margin: "0 0 8px" }}>
              {s.title}
            </h2>
            <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
              {s.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </section>
        ))}
        <p className="c-hint">Something not working? If the error message ends with a reference (it starts with req_), give it to your administrator: it finds exactly what happened.</p>
      </div>
    </div>
  );
}
