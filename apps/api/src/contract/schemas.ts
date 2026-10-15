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
});

const DefinitionIssueSchema = z.object({ path: z.string(), code: z.string(), message: z.string() });

export const DraftResponseSchema = z.object({
  revision: z.number().int().min(1),
  /** The form definition (contracts/form-definition.schema.json), possibly incomplete. */
  definition: z.record(z.string(), z.unknown()),
  /** Problems to fix before publishing; a draft may still be saved with them. */
  issues: z.array(DefinitionIssueSchema),
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
