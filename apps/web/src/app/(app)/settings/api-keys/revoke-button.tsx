"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { revokeApiKeyAction } from "../actions";

export function RevokeButton({ id }: { id: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  return confirming ? (
    <Button size="sm" variant="danger" disabled={pending} onClick={() => start(() => revokeApiKeyAction(id))}>
      Confirm revoke
    </Button>
  ) : (
    <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirming(true)}>
      Revoke
    </Button>
  );
}
