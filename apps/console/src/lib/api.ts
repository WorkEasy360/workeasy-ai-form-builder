/**
 * Browser-side calls to the API through the console's same-origin /api proxy.
 * The session cookie is HttpOnly and sent automatically; browsers add the
 * Origin header the API requires on mutations.
 */

export interface Problem {
  status: number;
  code: string;
  title: string;
  requestId?: string;
  errors?: Array<{ field: string; code: string; message: string }>;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError({ status: 0, code: "NETWORK", title: "We couldn't reach Workeasy Forms. Check your connection and try again." });
  }
  if (res.ok) return (await res.json()) as T;
  let problem: Problem = { status: res.status, code: "UNKNOWN", title: "Something went wrong." };
  try {
    problem = { ...problem, ...((await res.json()) as Partial<Problem>) };
  } catch {
    // Non-JSON error body; keep the generic problem.
  }
  throw new ApiError(problem);
}

export type FormState = "draft" | "published" | "closed" | "archived";

export interface FormSummary {
  id: string;
  slug: string;
  name: string;
  state: FormState;
  ownerId: string;
  activeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: string[];
}

/** A form in the list: response figures are null without permission to read responses. */
export interface FormListItem extends FormSummary {
  responseCount: number | null;
  lastResponseAt: string | null;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  schemaVersion: string;
  draftRevision: number;
  contentHash: string;
  publishedAt: string;
  publishedBy: { id: string; displayName: string | null };
  active: boolean;
}

export interface PublishResponse {
  form: FormSummary;
  version: VersionSummary;
}

export interface FormResponse {
  form: FormSummary;
  draft: { revision: number };
}

export interface Me {
  user: { id: string; displayName: string | null };
  organizations: Array<{ id: string; name: string; role: string; permissions: string[] }>;
}
