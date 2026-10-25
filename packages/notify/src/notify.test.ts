import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Actor,
  authenticateApiKey,
  createApiKey,
  createChannel,
  createDb,
  deliveries,
  type Event,
  listChannels,
  listEvents,
  matchesPattern,
  memberships,
  orgs,
  recordEvent,
  revokeApiKey,
  users,
} from "@oicr/db";
import { runMigrations } from "@oicr/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliverDue, formatLine, sendToChannel, signWebhook, webhookBody } from "./index.js";

let server: Server;
let base: string;
let status = 200;
const hits: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  process.env.ALLOW_PRIVATE_NETWORK = "true";
  process.env.SECRETS_KEY ??= randomBytes(32).toString("base64");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", headers: req.headers, body });
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(status < 300 ? '{"ok":true}' : '{"error":"nope"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  hits.length = 0;
  status = 200;
});

const event = (over: Partial<Event> = {}): Event => ({
  id: 7,
  orgId: randomUUID(),
  type: "instance.failed",
  severity: "error",
  subjectType: "instance",
  subjectId: randomUUID(),
  summary: '"Orders to shop" failed (A2): send: POST /orders returned 422',
  path: "/observability/runs/abc",
  data: { errorCode: "http_422" },
  createdAt: new Date("2026-10-25T10:00:00Z"),
  ...over,
});
const opts = { appUrl: "https://oicr.example.com/", telegramApiBase: "" };

describe("formatting", () => {
  it("writes one line with an icon and a link", () => {
    expect(formatLine(event(), opts.appUrl)).toEqual({
      text: '❌ "Orders to shop" failed (A2): send: POST /orders returned 422',
      url: "https://oicr.example.com/observability/runs/abc",
    });
    expect(formatLine(event({ type: "instance.succeeded", severity: "info" }), opts.appUrl).text.startsWith("✅")).toBe(
      true,
    );
  });

  it("matches event patterns", () => {
    expect(matchesPattern("instance.failed", ["*"])).toBe(true);
    expect(matchesPattern("instance.failed", ["instance.*"])).toBe(true);
    expect(matchesPattern("instance.failed", ["integration.*", "instance.failed"])).toBe(true);
    expect(matchesPattern("instance.succeeded", ["instance.failed"])).toBe(false);
    expect(matchesPattern("instancex.failed", ["instance.*"])).toBe(false);
  });
});

describe("senders", () => {
  it("posts Slack messages with a link", async () => {
    const r = await sendToChannel({ kind: "slack", config: { webhookUrl: `${base}/slack` } }, event(), opts);
    expect(r.ok).toBe(true);
    expect(JSON.parse(hits[0]!.body).text).toBe(
      '❌ "Orders to shop" failed (A2): send: POST /orders returned 422\n<https://oicr.example.com/observability/runs/abc|Open in OIC-Replica>',
    );
  });

  it("posts Telegram messages to the bot API", async () => {
    const r = await sendToChannel({ kind: "telegram", config: { botToken: "123:abc", chatId: "-100200" } }, event(), {
      ...opts,
      telegramApiBase: base,
    });
    expect(r.ok).toBe(true);
    expect(hits[0]!.url).toBe("/bot123:abc/sendMessage");
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ chat_id: "-100200", disable_web_page_preview: true });
  });

  it("signs webhooks the way Hermes Agent verifies them (Generic V2)", async () => {
    const r = await sendToChannel(
      { kind: "webhook", config: { url: `${base}/hook`, secret: "s".repeat(32) } },
      event(),
      opts,
      "d-1",
    );
    expect(r.ok).toBe(true);
    const h = hits[0]!;
    const ts = Number(h.headers["x-webhook-timestamp"]);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
    expect(h.headers["x-webhook-signature-v2"]).toBe(signWebhook("s".repeat(32), h.body, ts));
    expect(h.headers["x-oicr-event"]).toBe("instance.failed");
    expect(h.headers["x-oicr-delivery"]).toBe("d-1");
    expect(JSON.parse(h.body)).toMatchObject({
      id: 7,
      type: "instance.failed",
      summary: expect.any(String),
      url: "https://oicr.example.com/observability/runs/abc",
    });
    expect(webhookBody(event(), opts.appUrl).text).toContain("❌");
    expect(webhookBody(event(), opts.appUrl).event_type).toBe("instance.failed");
    expect(webhookBody(event({ path: null }), opts.appUrl).url).toBe("https://oicr.example.com");
  });

  it("reports retryable and permanent failures", async () => {
    status = 503;
    expect(
      await sendToChannel({ kind: "webhook", config: { url: `${base}/h`, secret: "x".repeat(16) } }, event(), opts),
    ).toMatchObject({ ok: false, retryable: true });
    status = 404;
    expect(
      await sendToChannel({ kind: "webhook", config: { url: `${base}/h`, secret: "x".repeat(16) } }, event(), opts),
    ).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining("404") });
  });

  it("explains that email needs setup", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await sendToChannel({ kind: "email", config: { to: ["a@b.co"] } }, event(), opts)).toMatchObject({
      ok: false,
      retryable: false,
      error: expect.stringContaining("RESEND_API_KEY"),
    });
  });

  it("refuses private addresses unless allowed", async () => {
    process.env.ALLOW_PRIVATE_NETWORK = "false";
    try {
      const r = await sendToChannel(
        { kind: "webhook", config: { url: `${base}/h`, secret: "x".repeat(16) } },
        event(),
        opts,
      );
      expect(r).toMatchObject({ ok: false, retryable: false });
    } finally {
      process.env.ALLOW_PRIVATE_NETWORK = "true";
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
const db = url ? createDb(url) : null;

describe.skipIf(!url)("events, channels and API keys (Postgres)", () => {
  let actor: Actor;

  beforeAll(async () => {
    await runMigrations(url);
    const [u] = await db!
      .insert(users)
      .values({ name: "N", email: `n-${randomUUID()}@example.com` })
      .returning();
    const [o] = await db!
      .insert(orgs)
      .values({ name: "N", slug: `n-${randomUUID()}` })
      .returning();
    await db!.insert(memberships).values({ organizationId: o!.id, userId: u!.id, role: "admin" });
    actor = { userId: u!.id, orgId: o!.id, role: "admin" };
  });
  afterAll(async () => {
    await db?.$client.end();
  });

  /** Runs the delivery loop until nothing is due (other test runs may have left rows behind). */
  const drain = async (o: Parameters<typeof deliverDue>[1]) => {
    const total = { sent: 0, retry: 0, failed: 0 };
    for (let i = 0; i < 20; i++) {
      const r = await deliverDue(db!, { ...o, batch: 200 });
      total.sent += r.sent;
      total.retry += r.retry;
      total.failed += r.failed;
      if (r.sent + r.retry + r.failed === 0) break;
    }
    return total;
  };

  const ev = (
    type: "instance.failed" | "instance.succeeded" | "integration.created",
    severity: "info" | "error" = "info",
  ) =>
    recordEvent(db!, {
      orgId: actor.orgId,
      type,
      severity,
      subjectType: "instance",
      subjectId: randomUUID(),
      summary: `${type} happened`,
    });

  it("validates channel settings and hides secrets", async () => {
    await expect(
      createChannel(db!, actor, { kind: "slack", name: "x", config: { webhookUrl: "https://evil.example.com/x" } }),
    ).rejects.toThrow(/hooks.slack.com/);
    await expect(
      createChannel(db!, actor, { kind: "telegram", name: "x", config: { botToken: "nope", chatId: "1" } }),
    ).rejects.toThrow(/BotFather/);
    await expect(
      createChannel(db!, { ...actor, role: "developer" }, { kind: "email", name: "x", config: { to: ["a@b.co"] } }),
    ).rejects.toThrow(/cannot admin/);
    const c = await createChannel(db!, actor, {
      kind: "telegram",
      name: "Ops chat",
      config: { botToken: "123456:AAEabcdefghijklmnopqrstuv", chatId: "-1001" },
    });
    expect(c.target).toBe("Telegram chat -1001");
    expect(JSON.stringify(await listChannels(db!, actor))).not.toContain("AAEabcdef");
  });

  it("fans events out to matching channels only, and delivers them signed", async () => {
    const failuresOnly = await createChannel(db!, actor, {
      kind: "webhook",
      name: "Hermes",
      eventTypes: ["instance.failed"],
      config: { url: `${base}/hermes`, secret: "h".repeat(32) },
    });
    const errorsOnly = await createChannel(db!, actor, {
      kind: "webhook",
      name: "Pager",
      minSeverity: "error",
      config: { url: `${base}/pager`, secret: "p".repeat(32) },
    });
    const okEvent = await ev("instance.succeeded");
    const badEvent = await ev("instance.failed", "error");
    const rows = await db!.select().from(deliveries).where(eq(deliveries.eventId, okEvent.id));
    // neither the failures-only nor the errors-only channel wants a success (the "*" Telegram channel does)
    expect(rows.map((d) => d.channelId)).not.toContain(failuresOnly.id);
    expect(rows.map((d) => d.channelId)).not.toContain(errorsOnly.id);
    const bad = await db!.select().from(deliveries).where(eq(deliveries.eventId, badEvent.id));
    expect(bad.map((d) => d.channelId).sort()).toEqual(expect.arrayContaining([failuresOnly.id, errorsOnly.id]));

    const r = await drain({ appUrl: "https://app.example.com", telegramApiBase: base });
    expect(r.sent).toBeGreaterThanOrEqual(2);
    const hermes = hits.find((h) => h.url === "/hermes")!;
    expect(hermes.headers["x-webhook-signature-v2"]).toBe(
      signWebhook("h".repeat(32), hermes.body, Number(hermes.headers["x-webhook-timestamp"])),
    );
    // nothing left to send
    expect((await drain({ appUrl: "x", telegramApiBase: base })).sent).toBe(0);
  });

  it("retries with backoff and gives up on permanent errors", async () => {
    status = 503;
    const e = await ev("instance.failed", "error");
    const r = await drain({ appUrl: "x", telegramApiBase: base });
    expect(r.retry).toBeGreaterThan(0);
    const [row] = await db!.select().from(deliveries).where(eq(deliveries.eventId, e.id)).limit(1);
    expect(row!.status).toBe("pending");
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(row!.lastError).toContain("503");

    status = 400;
    await db!
      .update(deliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(deliveries.eventId, e.id));
    const r2 = await drain({ appUrl: "x", telegramApiBase: base });
    expect(r2.failed).toBeGreaterThan(0);
  });

  it("lists events after a cursor for polling", async () => {
    const first = await listEvents(db!, actor, { limit: 500 });
    const a = await ev("integration.created");
    const b = await ev("instance.succeeded");
    const next = await listEvents(db!, actor, { sinceId: first.nextSinceId });
    expect(next.events.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(next.nextSinceId).toBe(b.id);
    expect((await listEvents(db!, actor, { sinceId: next.nextSinceId })).events).toEqual([]);
    expect((await listEvents(db!, { ...actor, orgId: randomUUID() }, {})).events).toEqual([]);
  });

  it("creates scoped API keys that authenticate and can be revoked", async () => {
    const { key, apiKey } = await createApiKey(db!, actor, { name: "Hermes", scopes: ["operate"] });
    expect(key).toMatch(/^oicr_[0-9a-f]{8}_/);
    const a = await authenticateApiKey(db!, `Bearer ${key}`);
    expect(a).toMatchObject({ orgId: actor.orgId, scopes: ["read", "operate"], keyName: "Hermes" });
    expect(await authenticateApiKey(db!, `Bearer ${key}x`)).toBeNull();
    expect(await authenticateApiKey(db!, "Bearer nope")).toBeNull();
    await revokeApiKey(db!, actor, apiKey.id);
    expect(await authenticateApiKey(db!, `Bearer ${key}`)).toBeNull();
  });
});
