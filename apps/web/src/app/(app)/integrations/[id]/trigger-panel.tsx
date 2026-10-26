"use client";

import { KeyRound } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createTokenAction } from "../actions";

/** The trigger URL and its token. Tokens are stored as hashes, so a new one is shown once. */
export function TriggerPanel({
  id,
  url,
  method,
  hint,
}: {
  id: string;
  url: string;
  method: string;
  hint: string | null;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = token ?? "<token>";
  const curl = `curl -X ${method} '${url}' \\\n  -H 'Authorization: Bearer ${shown}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-10045' \\\n  -d '{"name":"Ada","email":"ada@example.com"}'`;
  const create = () =>
    start(async () => {
      const r = await createTokenAction(id);
      setToken(r.token ?? null);
      setError(r.error ?? null);
    });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <div className="text-xs text-fg-muted">Endpoint</div>
        <code className="break-all font-mono text-xs">
          {method} {url}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {token ? (
          <span className="text-xs text-success">Copy the token now; it is not shown again.</span>
        ) : hint ? (
          <span className="text-xs text-fg-muted">
            Token ending in <code>…{hint}</code> is active.
          </span>
        ) : (
          <span className="text-xs text-fg-muted">No token yet: callers are refused until you create one.</span>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (!hint || confirm("Callers using the current token will be refused. Continue?")) create();
          }}
        >
          <KeyRound aria-hidden /> {hint ? "Replace token" : "Create token"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">{curl}</pre>
    </div>
  );
}
