"use client";

import { Send, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";
import { deleteChannelAction, testChannelAction, toggleChannelAction } from "../actions";

export function ChannelActions({ id, enabled }: { id: string; enabled: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => start(async () => setResult(await testChannelAction(id)))}
        >
          <Send aria-hidden /> Send test
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => start(() => toggleChannelAction(id, !enabled))}
        >
          {enabled ? "Pause" : "Resume"}
        </Button>
        {confirming ? (
          <Button size="sm" variant="danger" disabled={pending} onClick={() => start(() => deleteChannelAction(id))}>
            Confirm delete
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            aria-label="Delete channel"
            onClick={() => setConfirming(true)}
          >
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      {result && (
        <p role="status" className={`text-xs ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok ? result.message : result.error}
        </p>
      )}
    </div>
  );
}
