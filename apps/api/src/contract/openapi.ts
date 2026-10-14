import { z } from "zod";
import {
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
  ReadyResponseSchema,
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
        "Routes implemented through BLD-01. Organization routes derive the tenant from the authenticated membership; resources outside the caller's organizations return 404. Every response carries an X-Request-Id header, and every error is application/problem+json with the same requestId.",
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
          summary: "Restore an archived form to draft (requires forms.publish)",
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
