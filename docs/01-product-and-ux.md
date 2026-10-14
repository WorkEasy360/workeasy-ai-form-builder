# Product requirements and user experience

## 1. Product boundaries

Workeasy-AI-Form-builder owns form definitions, publication, respondent sessions, submission records, response access, automation configuration, and delivery history. HRMS remains the owner of employees and HR cases; Helpdesk owns tickets; AI Agent Platform owns agent deployments and executions. Form submissions can create or link these records through supported APIs. Never share product database tables.

The product must work independently of those integrations. If an integration is unavailable, accepted submissions remain safe and the delivery is retried. If AI is unavailable, manual editing and respondent submission continue working.

### Personas

| Persona | Primary job |
|---|---|
| Organization owner/admin | Membership, security, plan, domains, integration credentials |
| Form creator | Build, test, publish, share, improve forms |
| Response analyst | View authorized responses, filter, export, report |
| Approver | Decide assigned approval tasks with limited response access |
| Respondent | Complete a public, invited, or internal form |
| Platform operator | Reliability and abuse response; no default answer access |

### Measurable product outcomes

Proposed targets to measure in pilot: first simple published form within ten minutes; no code required for common forms; accessible mobile completion; visible saved state; no acknowledged response loss within the supported database failure model. Track publish completion, submission success, validation errors, AI acceptance, workflow delivery failures, and support incidents. Do not invent conversion guarantees.

## 2. Capability and release matrix

P1 = usable first release; P2 = business workflows; P3 = advanced/enterprise. P0 is engineering foundation. Items are Workeasy scope choices informed by the cited reference, not promises of identical vendor behavior.

| Area | P1 | P2 | P3 |
|---|---|---|---|
| Creation | Blank, templates, prompt-to-form, AI edits | PDF/image conversion, translation | Reusable organization field libraries |
| Manual builder | Add/reorder/duplicate/delete fields, sections, pages, undo/redo, autosave | Repeating groups, reusable blocks | Concurrent editing if justified |
| Fields | Text, textarea, email, phone, integer/decimal, date, time, choices, checkbox, rating, URL, file, consent | Address, name, currency, signature capture, formula, matrix, repeating groups | Lookup, barcode, geolocation, OCR, appointment/capacity |
| Layout | Responsive standard form, page navigation, theme tokens | Card/conversational presentation | Advanced branded layouts |
| Logic | Typed visibility/required conditions, forward page branching | Calculations, choice filtering, answer piping | Lookup-driven rules with defined offline behavior |
| Validation | Required, ranges, lengths, allowed choices and upload limits | Cross-field checks, organization data checks | Advanced deduplication policies |
| Sharing | Public URL, QR, iframe, organization-only forms | Invite-only, password, save/resume, edit receipts | Custom domains and controlled prefills |
| Responses | Table/detail, filters, pagination, authorized CSV export | Saved views, assignment, comments, revision history, PDFs | Advanced reports and warehouse export |
| Automation | Email, signed webhooks, delivery logs | Sequential/parallel approvals, conditions, delays, Workeasy connectors | Reusable workflows, additional connectors |
| Payments | None | Hosted checkout, reconciliation, refunds via provider adapter | Product catalog, inventory and coupons |
| AI | Generate schema, edit draft with review | Translate, OCR, copywriting, response summaries with opt-in | Organization knowledge grounding, evaluated recommendations |
| Collaboration | Org roles and explicit form grants | Groups, granular field masks | Enterprise federation/provisioning |
| Governance | Audit events, retention settings, tenant isolation | Export/deletion requests, legal-hold mechanism | Residency tiers, dedicated databases |
| Analytics | Aggregate views, starts, submissions, completion rate | Page drop-off, version comparisons, payment reports | Cohorts and controlled exports |
| Mobile | Responsive browser | Installable shell if useful | Explicit offline collection and sync |
| Platform | Usage counters, server-side limits | Billing adapter, entitlements | Enterprise plans and contractual controls |

Reference baseline: Zoho advertises manual and AI creation, numerous field types, branching, approvals, payment integrations, sharing, reporting, and mobile collection. See [official feature catalog](https://www.zoho.com/forms/features.html). This is a functional benchmark, not an internal architecture source.

## 3. Information architecture

Console routes:

```text
/o/:organizationId/dashboard
/o/:organizationId/forms
/o/:organizationId/forms/:formId/build
/o/:organizationId/forms/:formId/design
/o/:organizationId/forms/:formId/logic
/o/:organizationId/forms/:formId/settings
/o/:organizationId/forms/:formId/preview
/o/:organizationId/forms/:formId/share
/o/:organizationId/forms/:formId/responses
/o/:organizationId/forms/:formId/responses/:submissionId
/o/:organizationId/forms/:formId/analytics
/o/:organizationId/forms/:formId/workflows
/o/:organizationId/approvals
/o/:organizationId/templates
/o/:organizationId/integrations
/o/:organizationId/settings/{members,security,usage,billing,audit,domains}
```

Public routes: `/f/:slug`, `/f/:slug/success`, `/resume/:token`, `/edit/:token` (last two P2). Route tokens are exchanged immediately for scoped sessions and scrubbed from navigation/referrers/logs. A public slug is a locator, never an authorization credential.

### Builder layout

- Top bar: title, draft save state, undo/redo, preview, publish; distinguish published version from editable draft.
- Left rail: field palette, page tree, reusable templates.
- Center: actual shared renderer in edit mode; select and rearrange components.
- Right inspector: label, description, validation, choices, privacy classification, conditional behavior.
- AI drawer: prompt, proposed change summary, field-level diff, accept/reject. Preserve unsaved manual work.
- Tabs: Build, Design, Logic, Settings, Responses, Workflows, Share.
- On narrow screens, palette and properties become sheets. Keyboard users can add/reorder without dragging.

### Core user journeys

**Manual:** create blank draft → add pages and fields → configure validation → preview desktop/mobile → see publish checklist → publish immutable version → copy link/QR/embed → collect responses.

**AI:** describe purpose/audience → receive draft proposal → inspect fields and logic → accept into draft → refine in the same builder → preview/publish. AI never publishes or activates integrations automatically.

**Respondent:** resolve form access → start version-bound session → complete pages → upload if needed → submit → receive receipt. Network errors preserve in-memory answers; a retry uses the same idempotency key. P1 does not silently persist sensitive responses to local storage.

**Operations:** receive submission → inspect response → assign/approve if configured → observe deliveries → retry eligible failures → export authorized view.

### Required screen states

Every screen specifies loading, empty, validation failure, permission denied, network failure, and success. Builder additionally handles save conflict, AI timeout, invalid proposal, and unpublished changes. Public renderer handles closed/unpublished, expired session, exhausted quota, upload quarantine, rate limiting, duplicate retry, and offline connection loss. Responses show processing status separately from payment and approval state.

### Design system and accessibility

Use existing Workeasy design tokens if supplied; otherwise start with neutral surfaces, a single brand accent, consistent 8px spacing, readable typography, and visible focus indicators. No copied Zoho assets. Target WCAG 2.2 AA and verify with keyboard and screen reader testing as well as automated checks. Labels remain visible, errors identify fields, page transitions move focus predictably, required states are announced, and theme colors are contrast-checked. Support locale-specific formatting, explicit timezone, RTL layouts in P2, and reduced motion.

## 4. Roles and permissions

| Action | Owner | Admin | Creator | Analyst | Approver |
|---|---|---|---|---|---|
| Manage organization/billing | Yes | Delegated | No | No | No |
| Invite members/configure integrations | Yes | Yes | No | No | No |
| Create forms | Yes | Yes | Yes | No | No |
| Edit/publish form | Yes | Yes | Form grant | No | No |
| View responses | Yes | Yes | Separate grant | Form grant | Assigned task projection |
| Export responses | Yes | Yes | Separate grant | Separate grant | No |
| Decide approval | When assigned | When assigned | When assigned | When assigned | When assigned |
| Delete forms/responses | Yes | Explicit permission | Explicit permission | No | No |

Creator access does not inherently imply response access. Publication requires `forms.publish`; credentials require `integrations.manage`; exports require `responses.export`. Enforce organization membership plus resource grant and field restrictions in the backend, including worker jobs and exports. Owner bypass never crosses organizations.

## 5. Functional limits and semantics

Initial configurable engineering limits: 100 fields, 20 pages, 200 rules, 100 choices per choice field, 256 KiB answer JSON, 10 MiB per uploaded file, five files per upload field. These are initial defaults to validate with load tests, not subscription promises. P2 repeating groups: at most 50 rows and two nesting levels only after evaluator support. Publish rejects over-limit definitions.

Response limits are checked atomically with acceptance. Anonymous email/IP checks are abuse signals, not proof of one person. Guaranteed one-response rules require verified respondent identity or single-use invitations. Invitations are consumed only on successful submission commit. Scheduling uses UTC instants with an explicit display timezone.
