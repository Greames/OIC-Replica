"use server";

import { createLookup, deleteLookup, updateLookup } from "@oicr/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { type ActionResult, toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

export interface LookupPayload {
  name: string;
  description?: string;
  domains: string[];
  rows: string[][];
}

export async function saveLookupAction(
  id: string | null,
  payload: LookupPayload,
): Promise<ActionResult & { id?: string }> {
  const viewer = await requireViewer();
  try {
    const row = id ? await updateLookup(db, viewer, id, payload) : await createLookup(db, viewer, payload);
    revalidatePath("/lookups");
    revalidatePath(`/lookups/${row.id}`);
    return { ok: true, id: row.id, message: `Saved ${row.rows.length} row(s).` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function deleteLookupAction(id: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    await deleteLookup(db, viewer, id);
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/lookups");
  redirect("/lookups");
}
