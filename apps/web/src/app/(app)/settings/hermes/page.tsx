import { randomBytes } from "node:crypto";
import { can, listApiKeys, listChannels } from "@oicr/db";
import Link from "next/link";
import { Badge, Card } from "@/components/ui/card";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/session";
import { appUrl } from "../actions";
import { KeyForm } from "../api-keys/key-form";
import { Snippet } from "../copy-button";
import { ChannelForm } from "../notifications/channel-form";

export const metadata = { title: "Hermes Agent" };

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <h2 className="flex items-center gap-2 font-medium">
        <span className="flex size-6 items-center justify-center rounded-full bg-accent text-xs text-accent-fg">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

export default async function HermesPage() {
  const viewer = await requireViewer();
  if (!can(viewer.role, "admin"))
    return <Card className="p-5 text-sm text-fg-muted">Only admins set up Hermes Agent.</Card>;
  const base = await appUrl();
  const [keys, channels] = await Promise.all([listApiKeys(db, viewer), listChannels(db, viewer)]);
  const activeKeys = keys.filter((k) => !k.revokedAt);
  const hooks = channels.filter((c) => c.kind === "webhook");
  const secret = randomBytes(24).toString("base64url");

  const mcp = `# ~/.hermes/config.yaml
mcp_servers:
  oic_replica:
    url: "${base}/mcp"
    headers:
      Authorization: "Bearer \${OICR_API_KEY}"
    trust: untrusted`;

  const env = `# ~/.hermes/.env
OICR_API_KEY=oicr_…   # the key from step 1
OICR_WEBHOOK_SECRET=${hooks.length ? "…   # the secret of your webhook channel" : secret}`;

  const routes = `# ~/.hermes/config.yaml
platforms:
  webhook:
    enabled: true
    extra:
      host: "0.0.0.0"
      port: 8644
      routes:
        # Every update, pushed straight to your chat. No LLM call, no tokens.
        oicr-updates:
          secret: "\${OICR_WEBHOOK_SECRET}"
          deliver: "telegram"        # or slack, discord, whatsapp, signal, email…
          deliver_only: true
          prompt: "{text}\\n{url}"

        # Optional: when a run fails, let the agent look into it over MCP.
        oicr-failures:
          secret: "\${OICR_WEBHOOK_SECRET}"
          events: ["instance.failed"]
          deliver: "telegram"
          prompt: |
            An OIC-Replica integration run failed: {text}
            Use the oic_replica tools (get_run, get_integration) to find the
            failing step and the likely cause. Reply in three short lines:
            what failed, why, and what to change. Do not change anything.`;

  const poll = `#!/usr/bin/env bash
# No webhook? Poll instead (e.g. every minute from cron or a Hermes cron job).
# Prints one line per new update; keeps its cursor in ~/.oicr-cursor.
CURSOR=$(cat ~/.oicr-cursor 2>/dev/null || echo 0)
PAGE=$(curl -fsS -H "Authorization: Bearer $OICR_API_KEY" \\
  "${base}/api/v1/events?since_id=$CURSOR") || exit 1
echo "$PAGE" | jq -r '.events[] | "\\(.summary)  \\(.url)"'
echo "$PAGE" | jq -r '.next_since_id' > ~/.oicr-cursor`;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-muted">
        <a
          href="https://hermes-agent.nousresearch.com"
          className="text-accent hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          Hermes Agent
        </a>{" "}
        is an open-source agent that lives on your server and talks to you on Telegram, Slack, WhatsApp, Discord and
        more. Connected here, it tells you about every update the moment it happens, and you can ask it about your
        integrations, or have it run and fix them, in plain English from your phone.
      </p>

      <Step n={1} title="Create a key for Hermes">
        <p className="text-sm text-fg-muted">
          Hermes uses this key to read your integrations and runs over MCP. Tick <b>Operate</b> to let it run, activate
          and deactivate integrations; tick <b>Build</b> to let it ask the AI builder for changes.
        </p>
        {activeKeys.length > 0 && (
          <p className="text-sm">
            Existing keys:{" "}
            {activeKeys.map((k) => (
              <Badge key={k.id} className="mr-1">
                {k.name} ({k.scopes.join(", ")})
              </Badge>
            ))}{" "}
            <Link href="/settings/api-keys" className="text-accent hover:underline">
              manage
            </Link>
          </p>
        )}
        <KeyForm defaultName="Hermes Agent" defaultOperate />
      </Step>

      <Step n={2} title="Give Hermes the tools (MCP)">
        <p className="text-sm text-fg-muted">
          Add this to Hermes&apos; config, put the key in its <code>.env</code>, then run <code>/reload-mcp</code> in
          Hermes. Ask it &quot;which integrations failed today?&quot; to check.
        </p>
        <Snippet label="Hermes MCP config" text={mcp} />
        <Snippet label="Hermes environment" text={env} />
        <p className="text-xs text-fg-muted">
          Tools: list_projects, list_integrations, get_integration, list_runs, get_run, list_events (read);
          activate_integration, deactivate_integration, run_integration (operate); start_ai_build, continue_ai_build,
          accept_ai_change (build). Hermes&apos; <code>trust: untrusted</code> treats what the tools return as data, not
          instructions.
        </p>
      </Step>

      <Step n={3} title="Get every update (webhook)">
        <p className="text-sm text-fg-muted">
          Add the webhook routes to Hermes, start its gateway (<code>hermes gateway</code>), then point a webhook
          channel at it below. Requests are signed the way Hermes expects (<code>X-Webhook-Signature-V2</code>), and the
          payload carries <code>text</code>, <code>url</code>, <code>event_type</code> and <code>data</code> for
          templates.
        </p>
        <Snippet label="Hermes webhook routes" text={routes} />
        {hooks.length > 0 ? (
          <p className="text-sm">
            Webhook channels:{" "}
            {hooks.map((h) => (
              <Badge key={h.id} className="mr-1">
                {h.name}
              </Badge>
            ))}{" "}
            <Link href="/settings/notifications" className="text-accent hover:underline">
              test or manage
            </Link>
          </p>
        ) : null}
        <div className="rounded-lg border border-border p-4">
          <h3 className="mb-3 text-sm font-medium">Connect a Hermes webhook</h3>
          <ChannelForm
            defaultKind="webhook"
            defaultName="Hermes Agent"
            defaultUrl="https://your-hermes-host:8644/webhooks/oicr-updates"
            secret={secret}
            submitLabel="Connect Hermes"
          />
        </div>
        <p className="text-xs text-fg-muted">
          For the failure route, add a second webhook channel to <code>/webhooks/oicr-failures</code> with &quot;Only
          failed runs&quot;.
        </p>
      </Step>

      <Step n={4} title="No public address? Poll instead">
        <p className="text-sm text-fg-muted">
          If Hermes cannot receive webhooks, read the update feed on a schedule. The cursor makes sure nothing is missed
          or repeated.
        </p>
        <Snippet label="Polling script" text={poll} />
      </Step>
    </div>
  );
}
