import type { Response } from "express";

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

/** Writes an application/problem+json response (docs/05 §1). */
export function sendProblem(
  res: Response,
  status: number,
  code: string,
  title: string,
  extra?: { errors?: FieldError[] },
): void {
  res
    .status(status)
    .type("application/problem+json")
    .json({ type: `urn:workeasy:error:${code.toLowerCase()}`, title, status, code, ...extra });
}

export const problems = {
  unauthenticated: (res: Response) => sendProblem(res, 401, "UNAUTHENTICATED", "Sign in to continue"),
  forbidden: (res: Response) => sendProblem(res, 403, "FORBIDDEN", "You do not have permission to do this"),
  notFound: (res: Response) => sendProblem(res, 404, "NOT_FOUND", "Not found"),
  validation: (res: Response, errors: FieldError[]) =>
    sendProblem(res, 422, "VALIDATION_FAILED", "Some fields need attention", { errors }),
};
