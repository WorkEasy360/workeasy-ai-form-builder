import { FORM_PERMISSIONS, ORG_PERMISSIONS, ORG_ROLES } from "@workeasy/auth";
import { FORM_TEMPLATES } from "@workeasy/form-engine";
import { z } from "zod";

/**
 * Request/response contracts for the routes in this slice. The OpenAPI
 * document in contracts/openapi.json is generated from these schemas
 * (`pnpm --filter @workeasy/api openapi:write`) and checked for drift in tests.
 */

const Uuid = z.uuid();
const Timestamp = z.iso.datetime();

export const FORM_STATES = ["draft", "published", "closed", "archived"] as const;
export const ACCESS_MODES = ["public", "organization"] as const;

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  /** Matches the X-Request-Id response header; quote it when reporting a problem. */
  requestId: z.string(),
  errors: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })).optional(),
  checks: z.record(z.string(), z.string()).optional(),
  currentRevision: z.number().int().optional(),
  /** Where a respondent signs in, with SIGN_IN_REQUIRED. */
  signInUrl: z.url().optional(),
  /** When a scheduled form opens, with FORM_NOT_OPEN. */
  opensAt: Timestamp.optional(),
});

const DefinitionIssueSchema = z.object({ path: z.string(), code: z.string(), message: z.string() });

export const DraftResponseSchema = z.object({
  revision: z.number().int().min(1),
  /** The form definition (contracts/form-definition.schema.json), possibly incomplete. */
  definition: z.record(z.string(), z.unknown()),
  /** Problems to fix before publishing; a draft may still be saved with them. */
  issues: z.array(DefinitionIssueSchema),
  /** When and by whom this revision was saved (shown when resolving a conflict). */
  updatedAt: Timestamp,
  updatedBy: z.object({ id: Uuid, displayName: z.string().nullable() }),
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;

export const SaveDraftResponseSchema = z.object({
  revision: z.number().int().min(1),
  issues: z.array(DefinitionIssueSchema),
});
export type SaveDraftResponse = z.infer<typeof SaveDraftResponseSchema>;

export const ReadyResponseSchema = z.object({
  status: z.literal("ready"),
  checks: z.record(z.string(), z.literal("ok")),
});

export const MeResponseSchema = z.object({
  user: z.object({ id: Uuid, displayName: z.string().nullable() }),
  organizations: z.array(
    z.object({
      id: Uuid,
      name: z.string(),
      role: z.enum(ORG_ROLES),
      permissions: z.array(z.enum(ORG_PERMISSIONS)),
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const FormListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(500).optional(),
  state: z.enum(FORM_STATES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export const FormSummarySchema = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  state: z.enum(FORM_STATES),
  ownerId: Uuid,
  /** The published version new respondents get; null until the form is first published. */
  activeVersionId: Uuid.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The caller's effective permissions on this form (role defaults plus grants). */
  permissions: z.array(z.enum(FORM_PERMISSIONS)),
});
export type FormSummaryBody = z.infer<typeof FormSummarySchema>;

const FormName = z.string().trim().min(1).max(200);
const TEMPLATE_IDS = FORM_TEMPLATES.map((t) => t.id) as [string, ...string[]];

export const CreateFormBodySchema = z.object({
  name: FormName,
  /** Built-in template to start from; omit for a blank form. */
  template: z.enum(TEMPLATE_IDS).optional(),
});

export const DuplicateFormBodySchema = z.object({ name: FormName });

export const FormResponseSchema = z.object({
  form: FormSummarySchema,
  draft: z.object({ revision: z.number().int().min(1) }),
});
export type FormResponse = z.infer<typeof FormResponseSchema>;

export const FormTemplatesResponseSchema = z.object({
  templates: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
});

export const FormListResponseSchema = z.object({
  items: z.array(FormSummarySchema),
  nextCursor: z.string().optional(),
});
export type FormListResponse = z.infer<typeof FormListResponseSchema>;

export const FormGrantSchema = z.object({
  principalType: z.literal("user"),
  principalId: Uuid,
  permission: z.enum(FORM_PERMISSIONS),
});

export const MAX_GRANTS_PER_FORM = 500;

export const FormGrantsBodySchema = z.object({
  grants: z.array(FormGrantSchema).max(MAX_GRANTS_PER_FORM),
});

export const FormGrantsResponseSchema = z.object({
  grants: z.array(FormGrantSchema),
});
export type FormGrantsResponse = z.infer<typeof FormGrantsResponseSchema>;

export const VersionSummarySchema = z.object({
  id: Uuid,
  versionNumber: z.number().int().min(1),
  schemaVersion: z.string(),
  /** The draft revision this version was published from. */
  draftRevision: z.number().int().min(1),
  /** SHA-256 (hex) of the canonical definition; equal hashes mean identical content. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: Timestamp,
  publishedBy: z.object({ id: Uuid, displayName: z.string().nullable() }),
  /** True for the version new respondents currently get. */
  active: z.boolean(),
});
export type VersionSummaryBody = z.infer<typeof VersionSummarySchema>;

export const VersionListResponseSchema = z.object({ items: z.array(VersionSummarySchema) });
export type VersionListResponse = z.infer<typeof VersionListResponseSchema>;

export const VersionResponseSchema = z.object({
  version: VersionSummarySchema,
  /** The immutable published definition (contracts/form-definition.schema.json). */
  definition: z.record(z.string(), z.unknown()),
});
export type VersionResponse = z.infer<typeof VersionResponseSchema>;

const PublishWarningSchema = z.object({ code: z.string(), message: z.string() });

export const ValidateResponseSchema = z.object({
  revision: z.number().int().min(1),
  /** True when the draft passes the same checks publishing runs. */
  publishable: z.boolean(),
  /** Blocking problems; publishing is refused while any remain. */
  issues: z.array(DefinitionIssueSchema),
  /** Non-blocking notes, such as publishing content identical to the active version. */
  warnings: z.array(PublishWarningSchema),
});
export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

export const PublishResponseSchema = z.object({
  form: FormSummarySchema,
  version: VersionSummarySchema,
});
export type PublishResponse = z.infer<typeof PublishResponseSchema>;

export const ActivateVersionBodySchema = z.object({ versionId: Uuid });

/** Client-chosen key that makes a publish request safe to retry. */
export const IDEMPOTENCY_KEY_PATTERN = /^[!-~]{8,200}$/;

/** A partial change: send only what changes; null clears a limit or a date. */
export const AccessPolicyBodySchema = z
  .object({
    mode: z.enum(ACCESS_MODES).optional(),
    /** Stop accepting responses after this many. */
    maxResponses: z.number().int().min(1).max(10_000_000).nullable().optional(),
    /** Accept responses from this time (UTC). */
    openAt: Timestamp.nullable().optional(),
    /** Stop accepting responses at this time (UTC). */
    closeAt: Timestamp.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Send at least one setting to change" });

export const AccessPolicyResponseSchema = z.object({
  mode: z.enum(ACCESS_MODES),
  maxResponses: z.number().int().nullable(),
  openAt: Timestamp.nullable(),
  closeAt: Timestamp.nullable(),
  /** Responses stored so far. */
  acceptedResponses: z.number().int().min(0),
});
export type AccessPolicyResponse = z.infer<typeof AccessPolicyResponseSchema>;

export const CloseFormBodySchema = z.object({
  /** Optional note kept in the audit log; not shown to respondents. */
  reason: z.string().trim().max(500).optional(),
});

export const ShareResponseSchema = z.object({
  /** The public form link. A slug only locates a form; it never grants access. */
  url: z.url(),
  /** The same link for embedding: no outer page chrome, and it reports its height to the host page. */
  embedUrl: z.url(),
  /** Paste-ready HTML for a host page: the iframe plus a small script that resizes it. */
  embedHtml: z.string(),
  /** Text to encode in a QR code (the public link). */
  qrPayload: z.string(),
  /** Whether respondents can open the form right now. */
  live: z.boolean(),
  /** Who may respond. */
  accessMode: z.enum(ACCESS_MODES),
});
export type ShareResponse = z.infer<typeof ShareResponseSchema>;

export const PublicFormResponseSchema = z.object({
  slug: z.string(),
  /** Who may respond: anyone with the link, or signed-in members of the organization. */
  accessMode: z.enum(ACCESS_MODES),
  /** The live version; a session pins the version it started with. */
  versionId: Uuid,
  versionNumber: z.number().int().min(1),
  /** The version's public projection: what the renderer needs, nothing internal. */
  definition: z.record(z.string(), z.unknown()),
});
export type PublicFormResponse = z.infer<typeof PublicFormResponseSchema>;

export const SessionStartResponseSchema = PublicFormResponseSchema.extend({
  sessionId: Uuid,
  /** Bearer token for this session only. Keep it in memory; it is never shown again. */
  capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: Timestamp,
});
export type SessionStartResponse = z.infer<typeof SessionStartResponseSchema>;

export const PublicAcceptanceResponseSchema = z.object({
  accepting: z.literal(true),
  /** The version this session is pinned to. */
  versionId: Uuid,
});
export type PublicAcceptanceResponse = z.infer<typeof PublicAcceptanceResponseSchema>;

/** Answer JSON cap (docs/01 §5): 256 KiB. */
export const MAX_ANSWERS_BYTES = 256 * 1024;

export const SubmitBodySchema = z.object({
  /** Must be the version the session is pinned to. */
  formVersionId: Uuid,
  /** Answers keyed by field ID; the engine decodes and validates them. */
  answers: z.record(z.string(), z.unknown()),
});

export const ReceiptSchema = z.object({
  submissionId: Uuid,
  receiptId: Uuid,
  receivedAt: Timestamp,
  intakeState: z.literal("accepted"),
  /** The form's message after submitting. No answers are echoed back. */
  message: z.string(),
  /** Consents given, with the version of the wording the respondent saw. */
  consents: z.array(z.object({ fieldId: z.string(), consentTextVersion: z.string().nullable() })),
});
export type ReceiptBody = z.infer<typeof ReceiptSchema>;

/** Upload size cap (docs/01 §5): 10 MiB per file. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const UploadCreateBodySchema = z.object({
  /** A file field of the session's version. */
  fieldId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,79}$/),
  /** Shown back to the respondent and to reviewers; never used as a storage path. */
  fileName: z.string().min(1).max(255),
  /** Must be one of the field's allowed types; the scan checks the bytes match it. */
  contentType: z.string().min(3).max(100),
  bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

export const UPLOAD_STATES = ["awaiting_upload", "pending_scan", "scanning", "clean", "infected", "rejected", "expired", "purged"] as const;

export const UploadCreateResponseSchema = z.object({
  uploadId: Uuid,
  /** PUT the file here with exactly the headers below, before expiresAt. */
  uploadUrl: z.url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  expiresAt: Timestamp,
});
export type UploadCreateResponse = z.infer<typeof UploadCreateResponseSchema>;

export const UploadStatusResponseSchema = z.object({
  uploadId: Uuid,
  fieldId: z.string(),
  fileName: z.string(),
  bytes: z.number().int().nullable(),
  /** clean files can be submitted; infected and rejected ones cannot. */
  state: z.enum(UPLOAD_STATES),
  rejectionReason: z.enum(["malware", "type_mismatch", "size_mismatch", "too_large"]).nullable(),
});
export type UploadStatusResponse = z.infer<typeof UploadStatusResponseSchema>;

export const FileDownloadResponseSchema = z.object({
  /** Short-lived link that downloads the file as an attachment. */
  url: z.url(),
  expiresAt: Timestamp,
  fileName: z.string(),
  contentType: z.string(),
  bytes: z.number().int(),
});
export type FileDownloadResponse = z.infer<typeof FileDownloadResponseSchema>;

// Responses (RES-01) --------------------------------------------------------

export const ANSWER_FILTER_OPS = ["eq", "contains", "isEmpty", "isNotEmpty"] as const;

export const ResponseListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** From the previous page; keeps the same cutoff, so pages never repeat or skip a response. */
    cursor: z.string().min(1).max(500).optional(),
    /** Only responses to this version. */
    version: Uuid.optional(),
    /** Received at or after this instant. */
    from: Timestamp.optional(),
    /** Received before this instant. */
    to: Timestamp.optional(),
    /** One answer filter: a field ID the caller can read, an operator and (for eq/contains) a value. */
    field: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,79}$/).optional(),
    op: z.enum(ANSWER_FILTER_OPS).optional(),
    value: z.string().max(200).optional(),
  })
  .refine((q) => (q.field === undefined) === (q.op === undefined), { message: "field and op go together", path: ["op"] })
  .refine((q) => !(q.op === "eq" || q.op === "contains") || (q.value !== undefined && q.value !== ""), { message: "This filter needs a value", path: ["value"] });

const PRIVACY = z.enum(["ordinary", "personal", "sensitive"]);

export const MaskedAnswerSchema = z.union([
  z.object({ masked: z.literal(true) }),
  z.object({ masked: z.literal(false), value: z.unknown(), display: z.string() }),
]);

export const ResponseColumnSchema = z.object({
  fieldId: z.string(),
  label: z.string(),
  type: z.string(),
  privacy: PRIVACY,
  /** True when the caller may not see this field's answers. */
  masked: z.boolean(),
});

export const ResponseListResponseSchema = z.object({
  columns: z.array(ResponseColumnSchema),
  items: z.array(
    z.object({
      id: Uuid,
      receiptNumber: z.string(),
      receivedAt: Timestamp,
      versionNumber: z.number().int(),
      /** By field ID; only fields of the response's own version appear. */
      answers: z.record(z.string(), MaskedAnswerSchema),
    }),
  ),
  /** Responses received up to the cutoff (matching the filters is not reflected). */
  total: z.number().int(),
  /** Pages of this listing include responses received up to this instant. */
  cutoff: Timestamp,
  nextCursor: z.string().optional(),
});
export type ResponseListResponse = z.infer<typeof ResponseListResponseSchema>;

const AttachedFileSchema = z.object({ uploadId: Uuid, fileName: z.string(), bytes: z.number().int().nullable(), contentType: z.string().nullable() });

export const ResponseDetailResponseSchema = z.object({
  id: Uuid,
  receiptNumber: z.string(),
  receivedAt: Timestamp,
  version: z.object({ id: Uuid, versionNumber: z.number().int(), active: z.boolean() }),
  /** Who responded: anonymous, or a signed-in member (personal data, masked without responses.read_personal). */
  respondent: z.union([
    z.object({ kind: z.literal("anonymous") }),
    z.object({ kind: z.literal("member"), masked: z.literal(true) }),
    z.object({ kind: z.literal("member"), masked: z.literal(false), userId: Uuid, displayName: z.string().nullable() }),
  ]),
  /** The response's own version's questions, in order. */
  fields: z.array(
    ResponseColumnSchema.extend({
      answer: MaskedAnswerSchema,
      /** Attached files, only when the field is visible to the caller. */
      files: z.array(AttachedFileSchema).optional(),
    }),
  ),
});
export type ResponseDetailResponse = z.infer<typeof ResponseDetailResponseSchema>;

// Exports (RES-02) ----------------------------------------------------------

export const ExportCreateBodySchema = z
  .object({
    /** The same filters as the response list. */
    version: Uuid.optional(),
    from: Timestamp.optional(),
    to: Timestamp.optional(),
    field: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,79}$/).optional(),
    op: z.enum(ANSWER_FILTER_OPS).optional(),
    value: z.string().max(200).optional(),
    /**
     * Canonical values for machines (option IDs, ISO dates) without spreadsheet
     * protection. Never open a raw export in a spreadsheet.
     */
    raw: z.boolean().default(false),
  })
  .refine((q) => (q.field === undefined) === (q.op === undefined), { message: "field and op go together", path: ["op"] })
  .refine((q) => !(q.op === "eq" || q.op === "contains") || (q.value !== undefined && q.value !== ""), { message: "This filter needs a value", path: ["value"] });

export const ExportSchema = z.object({
  id: Uuid,
  formId: Uuid,
  /** purged: deleted because a response in it was deleted (GOV-01). */
  state: z.enum(["queued", "running", "succeeded", "failed", "expired", "purged"]),
  /** Why it failed: the requester lost access, the form went away, or an error. */
  failureCode: z.enum(["access_revoked", "form_unavailable", "error"]).nullable(),
  raw: z.boolean(),
  /** Responses received up to this instant are included. */
  cutoff: Timestamp,
  rowCount: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
  /** The file is deleted after this. */
  expiresAt: Timestamp.nullable(),
});
export type ExportBody = z.infer<typeof ExportSchema>;

export const ExportListResponseSchema = z.object({ items: z.array(ExportSchema) });

export const ExportDownloadResponseSchema = z.object({
  /** Downloads the CSV as an attachment; valid for 15 minutes. */
  url: z.url(),
  expiresAt: Timestamp,
  fileName: z.string(),
});
export type ExportDownloadResponse = z.infer<typeof ExportDownloadResponseSchema>;

// Governance (GOV-01) -------------------------------------------------------

export const DeletionBodySchema = z.object({
  /** Why it is being deleted; kept with the deletion record, never shown to respondents. */
  reason: z.string().trim().min(3).max(500),
});

export const RetentionBodySchema = z
  .object({
    /** Responses older than this are deleted and purged automatically. */
    retentionDays: z.number().int().min(1).max(3650).optional(),
    /** While on hold nothing on the form is deleted or purged (owners and admins only). */
    legalHold: z.boolean().optional(),
  })
  .refine((b) => b.retentionDays !== undefined || b.legalHold !== undefined, { message: "Send at least one setting to change" });

export const RetentionResponseSchema = z.object({ retentionDays: z.number().int(), legalHold: z.boolean() });
export type RetentionResponse = z.infer<typeof RetentionResponseSchema>;

export const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
  action: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/).optional(),
  resourceId: Uuid.optional(),
});

export const AuditListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: Uuid,
      occurredAt: Timestamp,
      actor: z.object({ type: z.enum(["user", "system"]), id: Uuid.nullable(), displayName: z.string().nullable() }),
      action: z.string(),
      resourceType: z.string(),
      resourceId: Uuid,
      requestId: z.string().nullable(),
      /** Identifiers and counts only; never answers. */
      metadata: z.record(z.string(), z.unknown()),
    }),
  ),
  nextCursor: z.string().optional(),
});
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

// Durable jobs (JOB-01) -------------------------------------------------------

export const JOB_STATUSES = ["queued", "running", "succeeded", "dead"] as const;

export const JobQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  type: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/).max(100).optional(),
});

/** A job as operators see it: state and attempts, never its payload. */
export const JobSchema = z.object({
  id: Uuid,
  type: z.string(),
  status: z.enum(JOB_STATUSES),
  sourceEventId: Uuid.nullable(),
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  /** A sanitized error code from the last failed attempt. */
  lastError: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  nextAttemptAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type JobBody = z.infer<typeof JobSchema>;

export const JobListResponseSchema = z.object({ items: z.array(JobSchema), nextCursor: z.string().optional() });
export type JobListResponse = z.infer<typeof JobListResponseSchema>;

export const JobResponseSchema = z.object({ job: JobSchema });
export type JobResponse = z.infer<typeof JobResponseSchema>;

// AI generation (AI-01) ---------------------------------------------------------

export const AI_OPERATIONS = ["create", "edit"] as const;
export const AI_GENERATION_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export const AiJobCreateBodySchema = z.object({
  prompt: z.string().trim().min(3).max(8000),
  /** "create" replaces the draft's content; "edit" changes it, keeping existing IDs. */
  operation: z.enum(AI_OPERATIONS),
  /** The draft revision the author is looking at; a newer draft is a conflict. */
  baseRevision: z.number().int().min(1),
});

/** A generation as its requester and editors see it. The prompt is never returned. */
export const AiGenerationSchema = z.object({
  id: Uuid,
  formId: Uuid,
  operation: z.enum(AI_OPERATIONS),
  status: z.enum(AI_GENERATION_STATUSES),
  baseRevision: z.number().int(),
  requestedBy: Uuid,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** A validated form definition, once succeeded. Applying it is a separate step. */
  proposal: z.record(z.string(), z.unknown()).nullable(),
  /** Counts, IDs and warning codes; on invalid output, issue paths and codes. */
  summary: z.record(z.string(), z.unknown()).nullable(),
  failureCode: z.string().nullable(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  createdAt: Timestamp,
  deadlineAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  /** How the proposal was decided (AI-02): applied to the draft at a revision, or rejected. */
  decision: z
    .object({ kind: z.enum(["applied", "rejected"]), by: Uuid, at: Timestamp, appliedRevision: z.number().int().nullable() })
    .nullable(),
});
export type AiGenerationBody = z.infer<typeof AiGenerationSchema>;

export const AiJobResponseSchema = z.object({ job: AiGenerationSchema });
export type AiJobResponse = z.infer<typeof AiJobResponseSchema>;

/** An organization's AI opt-in and daily budget (AI-03). */
export const AiSettingsBodySchema = z.object({
  enabled: z.boolean(),
  /** Tokens per UTC day across the organization, reserved worst-case per request. */
  dailyTokenLimit: z.number().int().min(1000).max(100_000_000),
});

export const AiSettingsResponseSchema = z.object({
  settings: AiSettingsBodySchema,
  /** Whether this deployment has an AI provider at all. */
  available: z.boolean(),
  today: z.object({ usedTokens: z.number().int(), reservedTokens: z.number().int() }),
});
export type AiSettingsResponse = z.infer<typeof AiSettingsResponseSchema>;

export const AiApplyBodySchema = z.object({
  /** The draft revision the author is looking at; it must still be the proposal's base. */
  expectedRevision: z.number().int().min(1),
});

export const AiApplyResponseSchema = z.object({ job: AiGenerationSchema, draft: z.object({ revision: z.number().int() }) });
export type AiApplyResponse = z.infer<typeof AiApplyResponseSchema>;
