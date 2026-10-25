"use server";

import {
  activateIntegration,
  createIntegration,
  deactivateIntegration,
  getIntegration,
  getTriggerToken,
  regenerateTriggerToken,
  saveDefinition,
  setSchedule,
} from "@oicr/db";
import type { Issue } from "@oicr/flow-schema";
import { startRun } from "@oicr/runtime";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { type ActionResult, toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

export async function createIntegrationAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  let id: string;
  try {
    id = (
      await createIntegration(db, viewer, {
        projectId: String(form.get("projectId") ?? ""),
        name: String(form.get("name") ?? ""),
        style: String(form.get("style") ?? "scheduled") as "scheduled",
      })
    ).id;
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/integrations");
  redirect(`/integrations/${id}`);
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  errors: Issue[];
  warnings: Issue[];
  hash?: string;
  status?: string;
}

export async function saveDefinitionAction(id: string, json: string, baseHash: string): Promise<SaveResult> {
  const viewer = await requireViewer();
  let definition: unknown;
  try {
    definition = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}`, errors: [], warnings: [] };
  }
  try {
    const r = await saveDefinition(db, viewer, id, definition, baseHash);
    revalidatePath(`/integrations/${id}`);
    return {
      ok: true,
      errors: r.errors,
      warnings: r.warnings,
      hash: r.integration.definitionHash,
      status: r.integration.status,
    };
  } catch (e) {
    return { ok: false, error: toActionError(e).error, errors: [], warnings: [] };
  }
}

export async function setScheduleAction(id: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await setSchedule(db, viewer, id, {
      kind: String(form.get("kind")) as "interval",
      expression: String(form.get("expression") ?? ""),
      timezone: String(form.get("timezone") || "UTC"),
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/integrations/${id}`);
  return { ok: true, message: "Schedule saved." };
}

export async function activateAction(
  id: string,
  tracingLevel: "production" | "audit" | "debug",
): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await activateIntegration(db, viewer, id, { tracingLevel });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/integrations/${id}`);
  return { ok: true };
}

export async function deactivateAction(id: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await deactivateIntegration(db, viewer, id);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/integrations/${id}`);
  return { ok: true };
}

/** "Run now": sync http integrations run inline with the given payload; others are queued. */
export async function runNowAction(
  id: string,
  payloadJson: string,
): Promise<ActionResult & { instanceId?: string; response?: unknown }> {
  const viewer = await requireViewer();
  let input: unknown = {};
  if (payloadJson.trim()) {
    try {
      input = JSON.parse(payloadJson);
    } catch (e) {
      return { error: `The test payload is not valid JSON: ${(e as Error).message}` };
    }
  }
  try {
    const integration = await getIntegration(db, viewer, id);
    if (integration.status !== "active") return { error: "Activate the integration to run it." };
    const def = integration.definition as { trigger?: { type?: string; sync?: boolean } };
    const sync = def.trigger?.type === "http" && def.trigger.sync === true;
    const r = await startRun(db, integration, { input, kind: "manual", sync });
    return { ok: true, instanceId: r.instanceId, response: r.response, error: r.error?.message };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revealTokenAction(
  id: string,
  regenerate = false,
): Promise<{ token?: string | null; error?: string }> {
  const viewer = await requireViewer();
  try {
    return { token: regenerate ? await regenerateTriggerToken(db, viewer, id) : await getTriggerToken(db, viewer, id) };
  } catch (e) {
    return { error: toActionError(e).error };
  }
}
