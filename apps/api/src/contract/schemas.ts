import { FORM_PERMISSIONS, ORG_PERMISSIONS, ORG_ROLES } from "@workeasy/auth";
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
});

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
