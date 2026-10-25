"use server";

import { getAdapter } from "@oicr/adapters";
import { createConnection, deleteConnection, testConnection, updateConnection } from "@oicr/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { type ActionResult, toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Turns the generic connection form into adapter properties + secret. */
function readForm(form: FormData) {
  const adapter = getAdapter(String(form.get("adapter") ?? "rest"));
  const authType = String(form.get("authType") ?? "none") as "none";
  const properties: Record<string, unknown> = {};
  const secret: Record<string, string> = {};
  for (const f of adapter.fields) {
    if (f.authTypes && !f.authTypes.includes(authType)) continue;
    const raw = String(form.get(f.key) ?? "");
    if (f.secret) {
      if (raw !== "") secret[f.key] = raw;
    } else if (f.type === "keyvalue") {
      properties[f.key] = parseHeaders(raw);
    } else if (raw !== "") {
      properties[f.key] = raw;
    }
  }
  return {
    name: String(form.get("name") ?? ""),
    adapter: adapter.id,
    role: String(form.get("role") ?? "invoke") as "invoke",
    projectId: (form.get("projectId") as string) || null,
    authType,
    properties,
    secret,
  };
}

export async function saveConnectionAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const id = form.get("id") as string | null;
  const input = readForm(form);
  let savedId: string;
  try {
    if (id) {
      const keepSecret = Object.keys(input.secret).length === 0;
      savedId = (await updateConnection(db, viewer, id, { ...input, secret: keepSecret ? undefined : input.secret }))
        .id;
    } else {
      const identifier = String(form.get("identifier") ?? "").trim();
      savedId = (
        await createConnection(db, viewer, {
          ...input,
          identifier: identifier || undefined,
          secret: input.authType === "none" ? null : input.secret,
        })
      ).id;
    }
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath("/connections");
  redirect(`/connections/${savedId}?saved=1`);
}

export async function testConnectionAction(id: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    const r = await testConnection(db, viewer, id);
    revalidatePath(`/connections/${id}`);
    return r.ok ? { ok: true, message: r.message } : { error: r.message };
  } catch (e) {
    return toActionError(e);
  }
}

export async function deleteConnectionAction(id: string): Promise<void> {
  const viewer = await requireViewer();
  await deleteConnection(db, viewer, id);
  revalidatePath("/connections");
  redirect("/connections");
}
