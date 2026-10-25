"use client";

import { CheckCircle2, PlugZap, XCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";
import { testConnectionAction } from "../actions";

export function TestButton({ id }: { id: string }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => start(async () => setResult(await testConnectionAction(id)))}
      >
        <PlugZap aria-hidden />
        {pending ? "Testing…" : "Test connection"}
      </Button>
      {result && (
        <p role="status" className={`flex items-center gap-1.5 text-sm ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
          {result.ok ? result.message : result.error}
        </p>
      )}
    </div>
  );
}
