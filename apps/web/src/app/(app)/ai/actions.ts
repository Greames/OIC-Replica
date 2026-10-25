"use server";

import { acceptAiChange, createAiSession, rejectAiChange } from "@oicr/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { type ActionResult, toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

/** Starts a conversation (new integration in a project, or edits to one integration). */
export async function startAiSessionAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const text = String(form.get("text") ?? "").trim();
  const integrationId = (form.get("integrationId") as string) || null;
  if (!text && !integrationId) return { error: "Describe the integration you want." };
  let id: string;
  try {
    id = (
      await createAiSession(db, viewer, {
        projectId: (form.get("projectId") as string) || null,
        integrationId,
        title: text || "Edit with AI",
      })
    ).id;
  } catch (e) {
    return toActionError(e);
  }
  redirect(text ? `/ai/${id}?send=${encodeURIComponent(text)}` : `/ai/${id}`);
}

export async function acceptChangeAction(changeId: string): Promise<ActionResult & { integrationId?: string }> {
  const viewer = await requireViewer();
  try {
    const { integrationId } = await acceptAiChange(db, viewer, changeId);
    revalidatePath("/integrations");
    return { ok: true, integrationId };
  } catch (e) {
    return toActionError(e);
  }
}

export async function rejectChangeAction(changeId: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await rejectAiChange(db, viewer, changeId);
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
