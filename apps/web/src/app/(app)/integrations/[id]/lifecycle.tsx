"use client";

import { Play, Power, PowerOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { activateAction, deactivateAction, runNowAction } from "../actions";

export function Lifecycle({
  id,
  status,
  tracingLevel,
  canOperate,
  needsPayload,
}: {
  id: string;
  status: string;
  tracingLevel: "production" | "audit" | "debug";
  canOperate: boolean;
  needsPayload: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tracing, setTracing] = useState(tracingLevel);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState('{\n  "name": "Ada",\n  "email": "Ada@Example.com"\n}');
  const [run, setRun] = useState<{ instanceId?: string; response?: unknown; error?: string } | null>(null);
  const active = status === "active";

  if (!canOperate) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        {active ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await deactivateAction(id);
                setError(r.error ?? null);
                router.refresh();
              })
            }
          >
            <PowerOff aria-hidden /> Deactivate
          </Button>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="tracing" className="text-xs text-fg-muted">
                Payload tracing
              </label>
              <Select
                id="tracing"
                className="w-auto"
                value={tracing}
                onChange={(e) => setTracing(e.target.value as "audit")}
              >
                <option value="production">Production: errors only</option>
                <option value="audit">Audit: payloads up to 64 KB</option>
                <option value="debug">Debug: payloads up to 1 MB</option>
              </Select>
            </div>
            <Button
              disabled={pending || status !== "configured"}
              title={status !== "configured" ? "Fix the problems below and save first." : undefined}
              onClick={() =>
                start(async () => {
                  const r = await activateAction(id, tracing);
                  setError(r.error ?? null);
                  router.refresh();
                })
              }
            >
              <Power aria-hidden /> Activate
            </Button>
          </>
        )}
        {active && (
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await runNowAction(id, needsPayload ? payload : "");
                setRun(r);
                setError(r.ok ? null : (r.error ?? null));
                if (r.ok && !needsPayload && r.instanceId) router.push(`/observability/runs/${r.instanceId}`);
              })
            }
          >
            <Play aria-hidden /> {pending ? "Running…" : needsPayload ? "Send test request" : "Run now"}
          </Button>
        )}
      </div>
      {active && needsPayload && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="payload" className="text-xs text-fg-muted">
            Test request body (JSON)
          </label>
          <Textarea
            id="payload"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            className="min-h-28 font-mono text-xs"
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {run?.instanceId && needsPayload && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium">Response</span>
            <Link href={`/observability/runs/${run.instanceId}`} className="text-accent hover:underline">
              See the run
            </Link>
          </div>
          <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(run.response ?? null, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
