"use server";

import { discoverBindings, ModelError, ProposalError } from "@oicr/ai";
import {
  addAttribute,
  catalogPath,
  decideProposal,
  resetBinding,
  resetObject,
  saveEntity,
  saveObject,
  setBinding,
} from "@oicr/db";
import { type AttributeInput, SampleError } from "@oicr/semantic";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getModel } from "@/lib/ai";
import { db } from "@/lib/db";
import { type ActionResult, toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

const refresh = (system?: string, object?: string) => {
  revalidatePath("/catalog");
  if (system && object) revalidatePath(catalogPath(system, object));
};

export async function createEntityAction(input: {
  name: string;
  label: string;
  description: string;
}): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await saveEntity(db, viewer, { ...input, attributes: [] });
  } catch (e) {
    return toActionError(e);
  }
  refresh();
  redirect(`/catalog/entities/${input.name}`);
}

export async function addAttributeAction(entity: string, attribute: AttributeInput): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await addAttribute(db, viewer, entity, attribute);
    revalidatePath(`/catalog/entities/${entity}`);
    return { ok: true, message: `Added ${attribute.name}.` };
  } catch (e) {
    return toActionError(e);
  }
}

export interface ObjectPayload {
  system: string;
  object: string;
  entity: string;
  label?: string;
}

/** Binds an object to an entity without AI; the fields are then bound by hand. */
export async function saveObjectAction(input: ObjectPayload, opts: { open?: boolean } = {}): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await saveObject(db, viewer, input);
  } catch (e) {
    return toActionError(e);
  }
  refresh(input.system, input.object);
  if (opts.open) redirect(catalogPath(input.system, input.object));
  return { ok: true, message: `${input.object} holds ${input.entity} records.` };
}

export async function resetObjectAction(system: string, object: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await resetObject(db, viewer, system, object);
  } catch (e) {
    return toActionError(e);
  }
  refresh(system, object);
  return { ok: true, message: "The workspace's bindings were removed." };
}

export interface BindingPayload {
  system: string;
  object: string;
  field: string;
  attribute: string | null;
  read?: string;
  write?: string;
  readOnly?: boolean;
}

export async function setBindingAction(input: BindingPayload): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await setBinding(db, viewer, input);
    refresh(input.system, input.object);
    return {
      ok: true,
      message: input.attribute ? `${input.field} → ${input.attribute}` : `${input.field} is unbound.`,
    };
  } catch (e) {
    return toActionError(e);
  }
}

export async function resetBindingAction(system: string, object: string, field: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await resetBinding(db, viewer, system, object, field);
    refresh(system, object);
    return { ok: true, message: `${field} uses the platform binding again.` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function decideProposalAction(
  id: string,
  system: string,
  object: string,
  decisions: { field: string; decision: "approve" | "reject"; attribute?: string }[],
): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    const p = await decideProposal(db, viewer, id, decisions);
    refresh(system, object);
    const left = p.items.filter((i) => i.decision === "pending").length;
    return { ok: true, message: left ? `${left} left to review.` : "Review complete." };
  } catch (e) {
    return toActionError(e);
  }
}

export interface DiscoverPayload {
  system: string;
  object: string;
  label?: string;
  entityHint?: string;
  sample: string;
  includeValues: boolean;
  autoApprove: boolean;
}

/** Asks the AI for bindings, then opens the object with the proposal to review. */
export async function discoverAction(input: DiscoverPayload): Promise<ActionResult> {
  const viewer = await requireViewer();
  const model = getModel();
  if (!model) return { error: "The AI is not configured on this server. Bind the fields by hand instead." };
  try {
    await discoverBindings(db, viewer, model, input);
  } catch (e) {
    if (e instanceof SampleError || e instanceof ProposalError) return { error: e.message };
    if (e instanceof ModelError)
      return {
        error:
          e.kind === "rate_limit"
            ? "The AI provider is rate limiting requests. Try again in a minute."
            : `The AI provider refused the request: ${e.message}`,
      };
    return toActionError(e);
  }
  refresh(input.system, input.object);
  redirect(catalogPath(input.system, input.object));
}
