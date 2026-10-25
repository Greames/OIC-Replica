"use client";

import { Eye, RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { revealTokenAction } from "../actions";

export function TriggerPanel({ id, url, method }: { id: string; url: string; method: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = token ?? "<token>";
  const curl = `curl -X ${method} '${url}' \\\n  -H 'Authorization: Bearer ${shown}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-10045' \\\n  -d '{"name":"Ada","email":"ada@example.com"}'`;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <div className="text-xs text-fg-muted">Endpoint</div>
        <code className="break-all font-mono text-xs">
          {method} {url}
        </code>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => start(async () => setToken((await revealTokenAction(id)).token ?? null))}
        >
          <Eye aria-hidden /> Show token
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (confirm("Callers using the old token will be refused. Continue?")) {
              start(async () => setToken((await revealTokenAction(id, true)).token ?? null));
            }
          }}
        >
          <RefreshCw aria-hidden /> New token
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">{curl}</pre>
    </div>
  );
}
