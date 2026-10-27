"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { resetObjectAction, saveObjectAction } from "../../../actions";

export function ObjectSettings({
  system,
  object,
  entity,
  entities,
  removable,
  platform,
}: {
  system: string;
  object: string;
  entity: string;
  entities: string[];
  removable: boolean;
  platform: boolean;
}) {
  const [choice, setChoice] = useState(entity);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => setResult(await saveObjectAction({ system, object, entity: choice })));
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="object-entity">Holds records of</Label>
          <Select id="object-entity" className="w-56" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {entities.map((e) => (
              <option key={e}>{e}</option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary" disabled={pending || choice === entity}>
          Change entity
        </Button>
        {choice !== entity && (
          <p className="basis-full text-sm text-fg-muted">
            Changing the entity removes this object's field bindings; bind its fields again afterwards.
          </p>
        )}
      </form>
      {removable && (
        <div className="flex flex-wrap items-center gap-3">
          {confirm ? (
            <>
              <span className="text-sm">
                {platform
                  ? "Remove the workspace's changes and go back to the platform bindings?"
                  : `Remove ${object} and all its bindings from the catalog?`}
              </span>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await resetObjectAction(system, object);
                    setResult(r);
                    setConfirm(false);
                    // A workspace object is gone once removed.
                    if (r.ok && !platform) router.push("/catalog");
                  })
                }
              >
                {platform ? "Reset" : "Remove"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              {platform ? "Reset to platform bindings" : "Remove from catalog"}
            </Button>
          )}
        </div>
      )}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok ? result.message : result.error}
        </p>
      )}
    </div>
  );
}
