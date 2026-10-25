# Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is an open-source agent that runs on
your own server and talks to you on Telegram, Slack, WhatsApp, Discord, Signal, email and more.
Connected to OIC-Replica it does two things:

1. **Tells you every update** the moment it happens (a run failed, an integration was activated,
   the AI builder has a question or a proposal), pushed to your chat by a signed webhook. No LLM
   call, no tokens.
2. **Answers and acts** over MCP: "which integrations failed today and why?", "run the orders
   sync", "add a retry to the shop call". What it may do depends on the API key you give it.

The app walks you through this with your own URLs filled in: **Settings → Hermes Agent**. This page
is the same thing in text.

## 1. Create a key

**Settings → API keys** (or step 1 on the Hermes page). Every key can read. Tick:

- **Operate** to let Hermes activate, deactivate and run integrations.
- **Build** to let it ask the AI builder for new integrations and changes, and accept them.

The key is shown once. Keys can never manage members, channels or other keys, and you can revoke
one at any time.

## 2. Tools (MCP)

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  oic_replica:
    url: "https://YOUR-APP/mcp"
    headers:
      Authorization: "Bearer ${OICR_API_KEY}"
    trust: untrusted
```

`~/.hermes/.env`:

```bash
OICR_API_KEY=oicr_…
```

Run `/reload-mcp` in Hermes. `trust: untrusted` makes Hermes treat what the tools return (names,
payloads, error messages from your systems) as data rather than instructions.

| tool | scope | what |
| --- | --- | --- |
| `list_projects`, `list_integrations`, `get_integration` | read | what exists, with the full definition |
| `list_runs`, `get_run` | read | runs by status / integration / business id; a run's error, failing step and step activity |
| `list_events` | read | every update after a cursor (`since_id` → `next_since_id`) |
| `activate_integration`, `deactivate_integration`, `run_integration` | operate | |
| `start_ai_build`, `continue_ai_build`, `accept_ai_change` | build | the AI builder, one turn per call |

Tools outside the key's scopes are not listed at all.

## 3. Every update (webhook)

Add routes to Hermes and start its gateway (`hermes gateway`):

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      host: "0.0.0.0"
      port: 8644
      routes:
        # Every update straight to your chat. No LLM call.
        oicr-updates:
          secret: "${OICR_WEBHOOK_SECRET}"
          deliver: "telegram"
          deliver_only: true
          prompt: "{text}\n{url}"

        # Optional: on a failed run, let the agent find out why over MCP.
        oicr-failures:
          secret: "${OICR_WEBHOOK_SECRET}"
          events: ["instance.failed"]
          deliver: "telegram"
          prompt: |
            An OIC-Replica integration run failed: {text}
            Use the oic_replica tools (get_run, get_integration) to find the
            failing step and the likely cause. Reply in three short lines:
            what failed, why, and what to change. Do not change anything.
```

Then in OIC-Replica, **Settings → Hermes Agent → Connect a Hermes webhook** (or a webhook channel in
**Settings → Notifications**) with `https://YOUR-HERMES-HOST:8644/webhooks/oicr-updates` and the
same secret as `OICR_WEBHOOK_SECRET`. Press **Send test**. For the failure route, add a second
webhook channel to `/webhooks/oicr-failures` with "Only failed runs".

Each request is signed the way Hermes's generic webhook check expects:

| header | value |
| --- | --- |
| `X-Webhook-Timestamp` | Unix seconds |
| `X-Webhook-Signature-V2` | hex HMAC-SHA256 of `"{timestamp}.{body}"` with the channel secret |
| `X-OICR-Event` | the event type, e.g. `instance.failed` |
| `X-OICR-Delivery` | delivery id (the same on retries) |

Body:

```json
{
  "id": 1042,
  "type": "instance.failed",
  "event_type": "instance.failed",
  "severity": "error",
  "summary": "Orders sync failed (order A2): The shop answered 422.",
  "text": "❌ Orders sync failed (order A2): The shop answered 422.",
  "url": "https://YOUR-APP/observability/runs/…",
  "subject": { "type": "instance", "id": "…" },
  "data": { "integrationId": "…", "errorCode": "http_422", "businessId": "A2", "durationMs": 812 },
  "created_at": "2026-10-25T09:14:03.000Z"
}
```

Failed sends are retried at 1 min, 5 min, 30 min and 2 h; the channel shows the last error.

## 4. No public address? Poll

If Hermes cannot receive webhooks, poll the feed on a schedule (cron, or a Hermes cron job). The
cursor means nothing is missed or repeated:

```bash
CURSOR=$(cat ~/.oicr-cursor 2>/dev/null || echo 0)
PAGE=$(curl -fsS -H "Authorization: Bearer $OICR_API_KEY" \
  "https://YOUR-APP/api/v1/events?since_id=$CURSOR") || exit 1
echo "$PAGE" | jq -r '.events[] | "\(.summary)  \(.url)"'
echo "$PAGE" | jq -r '.next_since_id' > ~/.oicr-cursor
```

## Event types

`integration.created`, `integration.updated`, `integration.activated`, `integration.deactivated`,
`instance.succeeded`, `instance.failed`, `schedule.skipped`, `connection.test_passed`,
`connection.test_failed`, `ai.question`, `ai.change.proposed`, `ai.change.accepted`,
`ai.change.rejected`, `channel.test`.
