import { createHmac } from "node:crypto";
import { assertPublicUrl, dispatcher } from "@oicr/adapters";
import type { ChannelKind, Event } from "@oicr/db";
import { request } from "undici";

export interface SendResult {
  ok: boolean;
  error?: string;
  /** Worth trying again later (timeouts, 5xx, 429). */
  retryable?: boolean;
}

export interface SendOptions {
  /** Public base URL of the app, for links in messages. */
  appUrl: string;
  /** Overrides for tests. */
  telegramApiBase?: string;
}

const ICON: Record<string, string> = { error: "❌", warning: "⚠️", info: "ℹ️" };

/** One line for chat apps: icon, summary, link. */
export function formatLine(
  event: Pick<Event, "type" | "severity" | "summary" | "path">,
  appUrl: string,
): { text: string; url: string | null } {
  const icon = event.type === "instance.succeeded" ? "✅" : (ICON[event.severity] ?? "•");
  const url = event.path ? `${appUrl.replace(/\/$/, "")}${event.path}` : null;
  return { text: `${icon} ${event.summary}`, url };
}

/** The JSON body of a webhook delivery. Stable: integrations (and Hermes routes) template on it. */
export function webhookBody(event: Event, appUrl: string) {
  const { text, url } = formatLine(event, appUrl);
  return {
    id: event.id,
    type: event.type,
    // Hermes Agent webhook routes filter on `event_type` (route `events: [...]`).
    event_type: event.type,
    severity: event.severity,
    summary: event.summary,
    text,
    // Always present: Hermes templates leave a missing {url} as literal text.
    url: url ?? appUrl.replace(/\/$/, ""),
    subject: { type: event.subjectType, id: event.subjectId },
    data: event.data,
    created_at: event.createdAt.toISOString(),
  };
}

/**
 * Signs like Hermes Agent's "Generic V2" webhook check: hex HMAC-SHA256 of
 * "<unix seconds>.<raw body>", sent as X-Webhook-Signature-V2 with
 * X-Webhook-Timestamp. Any receiver can verify it the same way.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

async function post(url: string, body: string, headers: Record<string, string>): Promise<SendResult> {
  try {
    assertPublicUrl(new URL(url));
    const res = await request(url, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "user-agent": "OIC-Replica-Notify/1", ...headers },
      dispatcher: dispatcher(),
      signal: AbortSignal.timeout(15_000),
    } as Parameters<typeof request>[1]);
    const text = (await res.body.text()).slice(0, 300);
    if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true };
    return {
      ok: false,
      error: `HTTP ${res.statusCode}${text ? `: ${text}` : ""}`,
      retryable: res.statusCode >= 500 || res.statusCode === 429 || res.statusCode === 408,
    };
  } catch (e) {
    const err = e as { code?: string; message?: string; name?: string };
    if (err.code === "private_network") return { ok: false, error: err.message, retryable: false };
    return {
      ok: false,
      error: err.name === "TimeoutError" ? "Timed out after 15 s." : (err.message ?? String(e)),
      retryable: true,
    };
  }
}

export async function sendToChannel(
  channel: { id?: string; kind: ChannelKind; config: Record<string, unknown> },
  event: Event,
  opts: SendOptions,
  deliveryId = "test",
): Promise<SendResult> {
  const { text, url } = formatLine(event, opts.appUrl);
  const c = channel.config;
  switch (channel.kind) {
    case "slack":
      return post(
        String(c.webhookUrl),
        JSON.stringify({ text: url ? `${text}\n<${url}|Open in OIC-Replica>` : text }),
        {},
      );
    case "telegram": {
      const base = (opts.telegramApiBase ?? process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org").replace(
        /\/$/,
        "",
      );
      return post(
        `${base}/bot${c.botToken}/sendMessage`,
        JSON.stringify({ chat_id: c.chatId, text: url ? `${text}\n${url}` : text, disable_web_page_preview: true }),
        {},
      );
    }
    case "email": {
      const key = process.env.RESEND_API_KEY;
      const from = process.env.EMAIL_FROM;
      if (!key || !from)
        return {
          ok: false,
          error: "Email is not set up on this server (RESEND_API_KEY and EMAIL_FROM).",
          retryable: false,
        };
      return post(
        "https://api.resend.com/emails",
        JSON.stringify({
          from,
          to: c.to,
          subject: text.slice(0, 120),
          text: url ? `${event.summary}\n\n${url}` : event.summary,
        }),
        { authorization: `Bearer ${key}` },
      );
    }
    case "webhook": {
      const body = JSON.stringify(webhookBody(event, opts.appUrl));
      const ts = Math.floor(Date.now() / 1000);
      return post(String(c.url), body, {
        "x-oicr-event": event.type,
        "x-oicr-delivery": deliveryId,
        "x-webhook-timestamp": String(ts),
        "x-webhook-signature-v2": signWebhook(String(c.secret), body, ts),
      });
    }
  }
}
