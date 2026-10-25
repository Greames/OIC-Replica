"use server";

import { randomUUID } from "node:crypto";
import {
  createApiKey,
  createChannel,
  deleteChannel,
  type Event,
  loadChannelForSend,
  revokeApiKey,
  setChannelEnabled,
} from "@oicr/db";
import { sendToChannel } from "@oicr/notify";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { type ActionResult, toActionError } from "@/lib/errors";
import { requireViewer } from "@/lib/session";

export const appUrl = async () =>
  (process.env.APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000").replace(/\/$/, "");

const PRESETS: Record<string, { eventTypes: string[]; minSeverity: "info" | "warning" | "error" }> = {
  everything: { eventTypes: ["*"], minSeverity: "info" },
  attention: { eventTypes: ["*"], minSeverity: "warning" },
  runs: { eventTypes: ["instance.*"], minSeverity: "info" },
  failures: { eventTypes: ["instance.failed"], minSeverity: "error" },
};

export async function createChannelAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const viewer = await requireViewer();
  const kind = String(form.get("kind")) as "slack" | "telegram" | "email" | "webhook";
  const preset = PRESETS[String(form.get("preset") ?? "everything")] ?? PRESETS.everything!;
  const config: Record<string, unknown> =
    kind === "slack"
      ? { webhookUrl: String(form.get("webhookUrl") ?? "").trim() }
      : kind === "telegram"
        ? { botToken: String(form.get("botToken") ?? "").trim(), chatId: String(form.get("chatId") ?? "").trim() }
        : kind === "email"
          ? {
              to: String(form.get("to") ?? "")
                .split(/[,\s]+/)
                .filter(Boolean),
            }
          : { url: String(form.get("url") ?? "").trim(), secret: String(form.get("secret") ?? "").trim() };
  try {
    await createChannel(db, viewer, { kind, name: String(form.get("name") ?? ""), config, ...preset });
  } catch (e) {
    const r = toActionError(e);
    return { ...r, error: r.error };
  }
  revalidatePath("/settings/notifications");
  revalidatePath("/settings/hermes");
  return { ok: true, message: "Channel added. Send a test to check it." };
}

export async function toggleChannelAction(id: string, enabled: boolean): Promise<void> {
  const viewer = await requireViewer();
  await setChannelEnabled(db, viewer, id, enabled);
  revalidatePath("/settings/notifications");
}

export async function deleteChannelAction(id: string): Promise<void> {
  const viewer = await requireViewer();
  await deleteChannel(db, viewer, id);
  revalidatePath("/settings/notifications");
  revalidatePath("/settings/hermes");
}

/** Sends a sample update straight to one channel and reports what happened. */
export async function testChannelAction(id: string): Promise<ActionResult> {
  const viewer = await requireViewer();
  try {
    const channel = await loadChannelForSend(db, viewer, id);
    const sample: Event = {
      id: 0,
      orgId: viewer.orgId,
      type: "channel.test",
      severity: "info",
      subjectType: "channel",
      subjectId: channel.id,
      summary: `Test from OIC-Replica: "${channel.name}" is connected. You will get updates here.`,
      path: "/activity",
      data: {},
      createdAt: new Date(),
    };
    const r = await sendToChannel(channel, sample, { appUrl: await appUrl() }, `test-${randomUUID()}`);
    return r.ok ? { ok: true, message: "Sent. Check that it arrived." } : { error: `Not delivered: ${r.error}` };
  } catch (e) {
    return toActionError(e);
  }
}

export async function createApiKeyAction(
  _prev: ActionResult & { key?: string },
  form: FormData,
): Promise<ActionResult & { key?: string }> {
  const viewer = await requireViewer();
  try {
    const scopes = ["build", "operate"].filter((s) => form.get(s) === "on") as ("build" | "operate")[];
    const { key } = await createApiKey(db, viewer, { name: String(form.get("name") ?? ""), scopes });
    revalidatePath("/settings/api-keys");
    return { ok: true, key };
  } catch (e) {
    return toActionError(e);
  }
}

export async function revokeApiKeyAction(id: string): Promise<void> {
  const viewer = await requireViewer();
  await revokeApiKey(db, viewer, id);
  revalidatePath("/settings/api-keys");
}
