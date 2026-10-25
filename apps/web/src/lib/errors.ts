import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError } from "@oicr/db";
import { z } from "zod";

export interface ActionResult {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
}

/** Turns known errors into something a form can show; rethrows the rest. */
export function toActionError(e: unknown): ActionResult {
  if (e instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of e.issues) {
      const key = issue.path.filter((p) => p !== "properties").join(".");
      fieldErrors[key] ??= issue.message;
    }
    return { error: e.issues[0]?.message ?? "Check the form.", fieldErrors };
  }
  if (
    e instanceof ConflictError ||
    e instanceof ForbiddenError ||
    e instanceof InvalidStateError ||
    e instanceof NotFoundError
  ) {
    return { error: e.message };
  }
  throw e;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
