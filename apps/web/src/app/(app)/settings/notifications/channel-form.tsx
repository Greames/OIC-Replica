"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { createChannelAction } from "../actions";

export function ChannelForm({
  defaultKind = "slack",
  defaultName = "",
  defaultUrl = "",
  secret,
  presetDefault = "everything",
  submitLabel = "Add channel",
}: {
  defaultKind?: "slack" | "telegram" | "email" | "webhook";
  defaultName?: string;
  defaultUrl?: string;
  /** A generated signing secret for webhooks. */
  secret: string;
  presetDefault?: string;
  submitLabel?: string;
}) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(createChannelAction, {});
  const [kind, setKind] = useState(defaultKind);
  // A successful submit resets the form's fields; keep the chosen kind in step with them.
  useEffect(() => {
    if (state.ok) setKind(defaultKind);
  }, [state, defaultKind]);
  const err = (k: string) => state.fieldErrors?.[`config.${k}`] ?? state.fieldErrors?.[k];
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ch-kind">Send to</Label>
        <Select id="ch-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="slack">Slack</option>
          <option value="telegram">Telegram</option>
          <option value="email">Email</option>
          <option value="webhook">Webhook (Hermes Agent, or any service)</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ch-name">Name</Label>
        <Input
          id="ch-name"
          name="name"
          defaultValue={defaultName}
          placeholder="e.g. Ops chat"
          required
          maxLength={80}
        />
        <FieldError>{err("name")}</FieldError>
      </div>

      {kind === "slack" && (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="ch-slack">Slack incoming webhook URL</Label>
          <Input id="ch-slack" name="webhookUrl" type="url" placeholder="https://hooks.slack.com/services/…" required />
          <p className="text-xs text-fg-muted">
            In Slack: Apps → Incoming Webhooks → Add to a channel, then copy the URL.
          </p>
          <FieldError>{err("webhookUrl")}</FieldError>
        </div>
      )}
      {kind === "telegram" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-tg-token">Bot token</Label>
            <Input
              id="ch-tg-token"
              name="botToken"
              type="password"
              placeholder="123456:ABC…"
              required
              autoComplete="off"
            />
            <p className="text-xs text-fg-muted">From @BotFather. Add the bot to your chat first.</p>
            <FieldError>{err("botToken")}</FieldError>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-tg-chat">Chat id</Label>
            <Input id="ch-tg-chat" name="chatId" placeholder="123456789 or -100…" required />
            <FieldError>{err("chatId")}</FieldError>
          </div>
        </>
      )}
      {kind === "email" && (
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="ch-email">Email addresses</Label>
          <Input id="ch-email" name="to" placeholder="ops@example.com, me@example.com" required />
          <p className="text-xs text-fg-muted">Needs RESEND_API_KEY and EMAIL_FROM on the server.</p>
          <FieldError>{err("to")}</FieldError>
        </div>
      )}
      {kind === "webhook" && (
        <>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="ch-url">URL</Label>
            <Input
              id="ch-url"
              name="url"
              type="url"
              defaultValue={defaultUrl}
              placeholder="https://your-hermes-host:8644/webhooks/oicr-updates"
              required
            />
            <FieldError>{err("url")}</FieldError>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="ch-secret">Signing secret</Label>
            <Input
              id="ch-secret"
              name="secret"
              defaultValue={secret}
              className="font-mono text-xs"
              required
              minLength={16}
            />
            <p className="text-xs text-fg-muted">
              Every request carries <code>X-Webhook-Signature-V2</code> (hex HMAC-SHA256 of <code>timestamp.body</code>)
              and <code>X-Webhook-Timestamp</code>. Put the same secret in the receiver.
            </p>
            <FieldError>{err("secret")}</FieldError>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="ch-preset">Which updates</Label>
        <Select id="ch-preset" name="preset" defaultValue={presetDefault}>
          <option value="everything">Every update</option>
          <option value="attention">Only what needs attention (warnings and failures)</option>
          <option value="runs">Every run (successes and failures)</option>
          <option value="failures">Only failed runs</option>
        </Select>
      </div>

      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : submitLabel}
        </Button>
        {state.message && (
          <p role="status" className="text-sm text-success">
            {state.message}
          </p>
        )}
        {state.error && !state.fieldErrors && <FieldError>{state.error}</FieldError>}
      </div>
    </form>
  );
}
