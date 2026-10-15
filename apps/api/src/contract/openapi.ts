import { z } from "zod";
import {
  ActivateVersionBodySchema,
  CloseFormBodySchema,
  DraftResponseSchema,
  SaveDraftResponseSchema,
  CreateFormBodySchema,
  DuplicateFormBodySchema,
  FormResponseSchema,
  FormTemplatesResponseSchema,
  FormGrantsBodySchema,
  FormGrantsResponseSchema,
  FormListQuerySchema,
  FormListResponseSchema,
  MeResponseSchema,
  ProblemSchema,
  PublicAcceptanceResponseSchema,
  PublicFormResponseSchema,
  PublishResponseSchema,
  ReadyResponseSchema,
  ShareResponseSchema,
  ValidateResponseSchema,
  VersionListResponseSchema,
  VersionResponseSchema,
} from "./schemas.js";

type JsonSchema = Record<string, unknown>;

function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, target: "draft-2020-12" }) as JsonSchema;
  return rest;
}

const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
});

const json = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema: schemaOf(schema, "output") } },
});

function queryParameters(schema: z.ZodObject): JsonSchema[] {
  const object = schemaOf(schema, "input") as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(object.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query",
    required: object.required?.includes(name) ?? false,
    schema: property,
  }));
}

const uuidPath = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});

/** OpenAPI 3.1 document for the routes implemented so far. */
export function buildOpenApiDocument(): JsonSchema {
  const unauthenticated = problem("No valid session");
  const crossOrigin = problem("Forbidden: missing permission, or a cookie-authenticated mutation not sent from the console origin");
  return {
    openapi: "3.1.0",
    info: {
      title: "Workeasy Forms API",
      version: "0.1.0",
      description:
        "Routes implemented through PUB-02. Organization routes derive the tenant from the authenticated membership; resources outside the caller's organizations return 404. Every response carries an X-Request-Id header, and every error is application/problem+json with the same requestId.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        consoleSession: {
          type: "apiKey",
          in: "cookie",
          name: "we_session",
          description: "HttpOnly session cookie set by /auth/callback (`__Host-we_session` when served over HTTPS).",
        },
      },
      schemas: { Problem: schemaOf(ProblemSchema, "output") },
    },
    paths: {
      "/health/live": {
        get: {
          operationId: "liveness",
          summary: "Process liveness",
          responses: { "200": { description: "The process is serving HTTP" } },
        },
      },
      "/health/ready": {
        get: {
          operationId: "readiness",
          summary: "Readiness: essential dependencies reachable and not shutting down",
          responses: {
            "200": json("Ready to serve traffic", ReadyResponseSchema),
            "503": problem("Not ready: a dependency is unavailable or the process is draining"),
          },
        },
      },
      "/auth/login": {
        get: {
          operationId: "beginLogin",
          summary: "Start OIDC sign-in (authorization code + PKCE)",
          responses: {
            "302": { description: "Redirect to the identity provider" },
            "503": problem("Identity provider unavailable"),
          },
        },
      },
      "/auth/callback": {
        get: {
          operationId: "completeLogin",
          summary: "OIDC redirect target; creates a session",
          responses: { "303": { description: "Redirect to the console; sets the session cookie on success" } },
        },
      },
      "/auth/logout": {
        post: {
          operationId: "logout",
          summary: "Revoke the current session",
          responses: { "303": { description: "Redirect to the console; clears the session cookie" }, "403": crossOrigin },
        },
      },
      "/api/v1/me": {
        get: {
          operationId: "getMe",
          summary: "Signed-in user, active memberships and organization permissions",
          security: [{ consoleSession: [] }],
          responses: { "200": json("Current user", MeResponseSchema), "401": unauthenticated },
        },
      },
      "/api/v1/form-templates": {
        get: {
          operationId: "listFormTemplates",
          summary: "Built-in templates a new form can start from",
          security: [{ consoleSession: [] }],
          responses: { "200": json("Templates", FormTemplatesResponseSchema), "401": unauthenticated },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        get: {
          operationId: "getForm",
          summary: "Form summary, the caller's permissions and the current draft revision",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("Form", FormResponseSchema),
            "401": unauthenticated,
            "404": problem("Organization or form not found or not visible"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/draft": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        get: {
          operationId: "getDraft",
          summary: "The editable draft definition and its revision (requires forms.edit)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("Draft; the ETag header carries its revision", DraftResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
          },
        },
        put: {
          operationId: "saveDraft",
          summary: "Replace the draft definition if the If-Match revision is current (requires forms.edit)",
          description:
            "The body is the form definition. Drafts may be incomplete (no fields yet); remaining problems are returned as issues. Malformed definitions are rejected with 422.",
          security: [{ consoleSession: [] }],
          parameters: [
            { name: "If-Match", in: "header", required: true, description: 'Draft ETag, e.g. "draft-3"', schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "urn:workeasy:forms:definition:1.0" } } },
          },
          responses: {
            "200": json("Saved; the ETag header carries the new revision", SaveDraftResponseSchema),
            "400": problem("If-Match is not a draft ETag, or the body is not JSON"),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("The form is archived"),
            "412": problem("DRAFT_CONFLICT: the draft changed since that revision; currentRevision is included"),
            "413": problem("Definition larger than 1 MiB"),
            "422": problem("Malformed definition"),
            "428": problem("If-Match header missing"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/duplicate": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Source form ID")],
        post: {
          operationId: "duplicateForm",
          summary: "Copy a form's draft into an independent new form (requires forms.create and forms.edit on the source)",
          description: "Only the draft definition is copied. Grants, workflow configuration, versions and responses are not.",
          security: [{ consoleSession: [] }],
          requestBody: { required: true, content: { "application/json": { schema: schemaOf(DuplicateFormBodySchema, "input") } } },
          responses: {
            "201": json("The new form; ETag carries its draft revision", FormResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or source form not found or not visible"),
            "422": problem("Invalid name"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/archive": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "archiveForm",
          summary: "Archive a form (requires forms.publish)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("The archived form", FormResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("The form is already archived"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/restore": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "restoreForm",
          summary: "Restore an archived form: to draft if never published, otherwise to closed (requires forms.publish)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("The restored form", FormResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("The form is not archived"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms": {
        post: {
          operationId: "createForm",
          summary: "Create a blank or template-based form (requires forms.create)",
          description: "The creator receives forms.edit, forms.publish and forms.manage_access on the new form.",
          security: [{ consoleSession: [] }],
          parameters: [uuidPath("orgId", "Organization (tenant) ID")],
          requestBody: { required: true, content: { "application/json": { schema: schemaOf(CreateFormBodySchema, "input") } } },
          responses: {
            "201": json("The new form; ETag carries its draft revision", FormResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization not found or not visible"),
            "422": problem("Invalid name or unknown template"),
          },
        },
        get: {
          operationId: "listForms",
          summary: "List forms the caller can read in an organization",
          security: [{ consoleSession: [] }],
          parameters: [uuidPath("orgId", "Organization (tenant) ID"), ...queryParameters(FormListQuerySchema)],
          responses: {
            "200": json("A page of form summaries, newest change first", FormListResponseSchema),
            "401": unauthenticated,
            "404": problem("Organization not found or not visible"),
            "422": problem("Invalid query parameters"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/validate": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "validateDraft",
          summary: "Run the publish checks on the current draft without changing anything (requires forms.edit)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("Checklist result for the current draft; the ETag header carries its revision", ValidateResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/publish": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "publishForm",
          summary: "Publish a draft revision as a new immutable version and make it active (requires forms.publish)",
          description:
            "The version, the active pointer, the audit entry and the form.published.v1 outbox event commit together. Retrying with the same Idempotency-Key returns the same version with Idempotent-Replayed: true.",
          security: [{ consoleSession: [] }],
          parameters: [
            { name: "If-Match", in: "header", required: true, description: 'Draft ETag of the revision to publish, e.g. "draft-3"', schema: { type: "string" } },
            { name: "Idempotency-Key", in: "header", required: true, description: "8 to 200 visible ASCII characters, unique per publish attempt", schema: { type: "string" } },
          ],
          responses: {
            "200": json("A replayed request: the version this key already created", PublishResponseSchema),
            "201": json("Published; Location points at the new version", PublishResponseSchema),
            "400": problem("If-Match is not a draft ETag, or the Idempotency-Key is missing or malformed"),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("FORM_ARCHIVED, or IDEMPOTENCY_CONFLICT: the key was used for a different revision"),
            "412": problem("DRAFT_CONFLICT: the draft changed since that revision; currentRevision is included"),
            "422": problem("NOT_PUBLISHABLE: the draft fails validation; errors lists each problem"),
            "428": problem("If-Match header missing"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/versions": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        get: {
          operationId: "listFormVersions",
          summary: "Published versions, newest first (requires forms.read)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("Version summaries", VersionListResponseSchema),
            "401": unauthenticated,
            "404": problem("Organization or form not found or not visible"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/versions/{versionId}": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID"), uuidPath("versionId", "Version ID")],
        get: {
          operationId: "getFormVersion",
          summary: "One published version with its immutable definition (requires forms.read)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("The version", VersionResponseSchema),
            "401": unauthenticated,
            "404": problem("Organization, form or version not found or not visible"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/activate-version": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "activateFormVersion",
          summary: "Make an existing version of this form the one new respondents get: rollback or roll forward (requires forms.publish)",
          description: "Only versions of the same form can be activated. The change is audited; activating the already-active version changes nothing.",
          security: [{ consoleSession: [] }],
          requestBody: { required: true, content: { "application/json": { schema: schemaOf(ActivateVersionBodySchema, "input") } } },
          responses: {
            "200": json("The form and its now-active version", PublishResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("FORM_ARCHIVED"),
            "422": problem("UNKNOWN_VERSION: not a version of this form"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/share": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        get: {
          operationId: "getFormShare",
          summary: "Public link, embed snippet and QR payload (requires forms.read)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("Sharing options; live says whether respondents can open the form now", ShareResponseSchema),
            "401": unauthenticated,
            "404": problem("Organization or form not found or not visible"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/close": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "closeForm",
          summary: "Stop accepting responses, immediately and including pages already open (requires forms.publish)",
          security: [{ consoleSession: [] }],
          requestBody: { required: false, content: { "application/json": { schema: schemaOf(CloseFormBodySchema, "input") } } },
          responses: {
            "200": json("The closed form", FormResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("FORM_STATE_CONFLICT: only a published form can be closed"),
            "422": problem("Reason longer than 500 characters"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/reopen": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        post: {
          operationId: "reopenForm",
          summary: "Accept responses again for the active version (requires forms.publish)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("The reopened form", FormResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "409": problem("FORM_STATE_CONFLICT: only a closed form can be reopened"),
          },
        },
      },
      "/public/v1/forms/{slug}": {
        parameters: [{ name: "slug", in: "path", required: true, description: "Public form locator; never a credential", schema: { type: "string" } }],
        get: {
          operationId: "getPublicForm",
          summary: "A published form's active version, for respondents (no session)",
          description: "Cache-Control: public, max-age=30. Unknown, draft, archived and deleted forms are all 404.",
          responses: {
            "200": json("The active version's public projection", PublicFormResponseSchema),
            "404": problem("No published form at this slug"),
            "410": problem("FORM_CLOSED: the form is closed"),
          },
        },
      },
      "/public/v1/forms/{slug}/acceptance": {
        parameters: [
          { name: "slug", in: "path", required: true, description: "Public form locator", schema: { type: "string" } },
          { name: "versionId", in: "query", required: true, description: "The version the page was loaded with", schema: { type: "string", format: "uuid" } },
        ],
        get: {
          operationId: "getPublicFormAcceptance",
          summary: "Whether the form accepts a response for this version right now (never cached)",
          responses: {
            "200": json("Accepting", PublicAcceptanceResponseSchema),
            "404": problem("No published form at this slug"),
            "409": problem("VERSION_CHANGED: a newer version is live; reload the form"),
            "410": problem("FORM_CLOSED: the form was closed"),
            "422": problem("versionId missing or not a UUID"),
          },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/grants": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        get: {
          operationId: "getFormGrants",
          summary: "List explicit grants on a form (requires forms.manage_access)",
          security: [{ consoleSession: [] }],
          responses: {
            "200": json("Grants", FormGrantsResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
          },
        },
        put: {
          operationId: "replaceFormGrants",
          summary: "Replace all explicit grants on a form (requires forms.manage_access)",
          security: [{ consoleSession: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaOf(FormGrantsBodySchema, "input") } },
          },
          responses: {
            "200": json("Grants after the change", FormGrantsResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "422": problem("Invalid grants, or principals who are not active members"),
          },
        },
      },
    },
  };
}
