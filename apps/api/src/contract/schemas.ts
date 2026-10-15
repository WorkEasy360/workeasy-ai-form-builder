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

export const AccessPolicyBodySchema = z.object({ mode: z.enum(ACCESS_MODES) });
export const AccessPolicyResponseSchema = z.object({ mode: z.enum(ACCESS_MODES) });
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
