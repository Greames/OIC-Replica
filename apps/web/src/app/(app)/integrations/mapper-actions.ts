"use server";

import { getIntegration, loadLookup, setSample } from "@oicr/db";
import { evaluateExpression, LOOKUP_FUNCTION, lookupFunction } from "@oicr/flow-schema";
import { db } from "@/lib/db";
import { toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

/** The mapper's test pane: evaluates an expression against sample bindings, with the org's lookups. */
export async function testExpressionAction(
  integrationId: string,
  expression: string,
  bindingsJson: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const viewer = await requireViewer();
  await getIntegration(db, viewer, integrationId);
  let bindings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bindingsJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error('Give an object of sources, e.g. { "trigger": {…} }.');
    bindings = parsed;
  } catch (e) {
    return { ok: false, error: `The sample data is not valid: ${(e as Error).message}` };
  }
  try {
    const lookupValue = lookupFunction((name) => loadLookup(db, viewer.orgId, name));
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("The expression took longer than 5 seconds.")), 5000),
    );
    const result = await Promise.race([
      evaluateExpression(expression, bindings.trigger ?? {}, { ...bindings, [LOOKUP_FUNCTION]: lookupValue }),
      timeout,
    ]);
    return { ok: true, result: result ?? null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Saves a pasted sample for a source (null removes it). */
export async function setSampleAction(
  integrationId: string,
  source: string,
  json: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const viewer = await requireViewer();
  let value: unknown = null;
  if (json !== null) {
    try {
      value = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
  }
  try {
    await setSample(db, viewer, integrationId, source, value);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: toActionError(e).error };
  }
}
