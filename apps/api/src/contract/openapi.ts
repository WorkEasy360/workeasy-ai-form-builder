import { z } from "zod";
import {
  AccessPolicyBodySchema,
  AccessPolicyResponseSchema,
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
  ReceiptSchema,
  SessionStartResponseSchema,
  ShareResponseSchema,
  SubmitBodySchema,
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
        "Routes implemented through RUN-02. Organization routes derive the tenant from the authenticated membership; resources outside the caller's organizations return 404. Every response carries an X-Request-Id header, and every error is application/problem+json with the same requestId.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        respondentSession: {
          type: "apiKey",
          in: "cookie",
          name: "we_respondent",
          description: "Respondent sign-in on the respondent origin, for organization-only forms (`__Host-we_respondent` over HTTPS).",
        },
        sessionCapability: {
          type: "http",
          scheme: "bearer",
          description: "The capability returned when a respondent session starts. Kept in memory by the browser.",
        },
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
          summary: "A published form's live version, for rendering (respondents answer through a session)",
          description:
            "Anyone-with-the-link forms: Cache-Control public, max-age=30. Organization-only forms need the respondent sign-in and are private, no-store. Unknown, draft, archived and deleted forms are all 404.",
          security: [{}, { respondentSession: [] }],
          responses: {
            "200": json("The active version's public projection", PublicFormResponseSchema),
            "401": problem("SIGN_IN_REQUIRED: organization-only form; sign in at signInUrl"),
            "403": problem("NOT_A_MEMBER: signed in, but not a member of the form's organization"),
            "404": problem("No published form at this slug"),
            "410": problem("FORM_CLOSED: the form is closed"),
          },
        },
      },
      "/public/v1/forms/{slug}/sessions": {
        parameters: [{ name: "slug", in: "path", required: true, description: "Public form locator", schema: { type: "string" } }],
        post: {
          operationId: "startRespondentSession",
          summary: "Start a respondent session pinned to the live version (respondent origin only)",
          description:
            "Organization-only forms need a respondent sign-in and an active membership. The capability is returned once; only its hash is stored. Sessions last two hours and keep their version even if a newer one is published.",
          security: [{}, { respondentSession: [] }],
          responses: {
            "201": json("Session started", SessionStartResponseSchema),
            "401": problem("SIGN_IN_REQUIRED: sign in at signInUrl (organization-only forms)"),
            "403": problem("NOT_A_MEMBER, or CROSS_ORIGIN_REQUEST when not sent from the respondent origin"),
            "404": problem("No published form at this slug"),
            "410": problem("FORM_CLOSED"),
          },
        },
      },
      "/public/v1/sessions/{sessionId}/acceptance": {
        parameters: [uuidPath("sessionId", "Respondent session ID")],
        get: {
          operationId: "getSessionAcceptance",
          summary: "Whether this session may submit right now (never cached)",
          description: "Reads the current form state and access policy, so closing a form or revoking a member takes effect immediately.",
          security: [{ sessionCapability: [] }],
          responses: {
            "200": json("Accepting, with the session's pinned version", PublicAcceptanceResponseSchema),
            "401": problem("SESSION_INVALID: missing, forged, expired or another session's capability"),
            "403": problem("NOT_A_MEMBER: the respondent no longer has access"),
            "404": problem("The form is no longer available"),
            "410": problem("FORM_CLOSED"),
          },
        },
      },
      "/public/v1/sessions/{sessionId}/submissions": {
        parameters: [uuidPath("sessionId", "Respondent session ID")],
        post: {
          operationId: "submitResponse",
          summary: "Submit the session's answers (intake transaction)",
          description:
            "The response, its idempotency record, the session's accepted marker and a submission.accepted.v1 event commit together, after the form's state and the respondent's access are rechecked under a lock and the answers pass the server engine. A session accepts one response. Retrying with the same Idempotency-Key and content returns the recorded receipt (Idempotent-Replayed: true); a later request under another key gets the first receipt (Submission-Already-Accepted: true). Answers are never echoed back.",
          security: [{ sessionCapability: [] }],
          parameters: [{ name: "Idempotency-Key", in: "header", required: true, description: "8 to 200 visible ASCII characters; reuse it when retrying the same answers", schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: schemaOf(SubmitBodySchema, "input") } } },
          responses: {
            "200": json("The session's earlier receipt (Submission-Already-Accepted: true)", ReceiptSchema),
            "201": json("Accepted (or a replay of the same request, with Idempotent-Replayed: true)", ReceiptSchema),
            "400": problem("IDEMPOTENCY_KEY_REQUIRED"),
            "401": problem("SESSION_INVALID"),
            "403": problem("NOT_A_MEMBER: the respondent no longer has access"),
            "404": problem("The form is no longer available"),
            "409": problem("IDEMPOTENCY_CONFLICT (same key, different answers) or VERSION_MISMATCH (not the session's version)"),
            "410": problem("FORM_CLOSED"),
            "413": problem("ANSWERS_TOO_LARGE: over 256 KiB"),
            "422": problem("VALIDATION_FAILED: field errors from the engine, as answers.<fieldId>"),
          },
        },
      },
      "/public/v1/auth/login": {
        get: {
          operationId: "beginRespondentLogin",
          summary: "Start respondent sign-in on the respondent origin",
          parameters: [{ name: "returnTo", in: "query", required: false, description: "A form page, /f/<slug> (optionally ?embed=1); anything else is ignored", schema: { type: "string" } }],
          responses: { "302": { description: "Redirect to the identity provider" }, "503": problem("Identity provider unavailable") },
        },
      },
      "/public/v1/auth/callback": {
        get: {
          operationId: "completeRespondentLogin",
          summary: "OIDC redirect target for respondents; sets the respondent cookie",
          responses: { "303": { description: "Redirect to the form page, or the respondent home" } },
        },
      },
      "/public/v1/auth/logout": {
        post: {
          operationId: "respondentLogout",
          summary: "Sign the respondent out",
          responses: { "303": { description: "Redirect; clears the respondent cookie" }, "403": problem("Not sent from the respondent origin") },
        },
      },
      "/api/v1/organizations/{orgId}/forms/{formId}/access-policy": {
        parameters: [uuidPath("orgId", "Organization (tenant) ID"), uuidPath("formId", "Form ID")],
        get: {
          operationId: "getAccessPolicy",
          summary: "Who may respond to the form (requires forms.read)",
          security: [{ consoleSession: [] }],
          responses: { "200": json("The access policy", AccessPolicyResponseSchema), "401": unauthenticated, "404": problem("Organization or form not found or not visible") },
        },
        patch: {
          operationId: "updateAccessPolicy",
          summary: "Anyone with the link, or signed-in members of the organization only (requires forms.publish)",
          description: "Takes effect immediately, including for respondent sessions already started. Changes are audited.",
          security: [{ consoleSession: [] }],
          requestBody: { required: true, content: { "application/json": { schema: schemaOf(AccessPolicyBodySchema, "input") } } },
          responses: {
            "200": json("The access policy after the change", AccessPolicyResponseSchema),
            "401": unauthenticated,
            "403": crossOrigin,
            "404": problem("Organization or form not found or not visible"),
            "422": problem("Unknown mode"),
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
