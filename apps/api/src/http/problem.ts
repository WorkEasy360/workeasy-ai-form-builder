import type { Response } from "express";
import { requestIdOf } from "./request-context.js";

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ProblemExtensions {
  errors?: FieldError[];
  /** Per-dependency status for readiness failures. */
  checks?: Record<string, string>;
  /** Current draft revision, returned with a 412 draft conflict. */
  currentRevision?: number;
  /** Where a respondent signs in, returned with SIGN_IN_REQUIRED. */
  signInUrl?: string;
}

/**
 * Writes an application/problem+json response (docs/05 §1). Every problem
 * carries the request ID so a user-reported failure can be found in the logs.
 */
export function sendProblem(res: Response, status: number, code: string, title: string, extra?: ProblemExtensions): void {
  res
    .status(status)
    .type("application/problem+json")
    .json({
      type: `urn:workeasy:error:${code.toLowerCase()}`,
      title,
      status,
      code,
      requestId: requestIdOf(res) ?? "unknown",
      ...extra,
    });
}

export const problems = {
  unauthenticated: (res: Response) => sendProblem(res, 401, "UNAUTHENTICATED", "Sign in to continue"),
  forbidden: (res: Response) => sendProblem(res, 403, "FORBIDDEN", "You do not have permission to do this"),
  notFound: (res: Response) => sendProblem(res, 404, "NOT_FOUND", "Not found"),
  validation: (res: Response, errors: FieldError[]) =>
    sendProblem(res, 422, "VALIDATION_FAILED", "Some fields need attention", { errors }),
};
