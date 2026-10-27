"use client";

import { Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { discoverAction, saveObjectAction } from "../actions";

const PLACEHOLDER = `Paste JSON records (an API response works), CSV with a header row, or one column per line:
ACCOUNT_NUMBER VARCHAR2(30) Customer account number
ACCOUNT_NAME   VARCHAR2(240)
STATUS         VARCHAR2(1)  A active, I inactive`;

export function DiscoverForm({
  initial,
  systems,
  entities,
  ai,
}: {
  initial: { system: string; object: string };
  systems: { id: string; label: string }[];
  entities: { name: string; label: string }[];
  ai: { label: string } | { hint: string };
}) {
  const [system, setSystem] = useState(initial.system);
  const [object, setObject] = useState(initial.object);
  const [label, setLabel] = useState("");
  const [entity, setEntity] = useState("");
  const [sample, setSample] = useState("");
  const [includeValues, setIncludeValues] = useState(true);
  const [autoApprove, setAutoApprove] = useState(true);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"ai" | "manual" | null>(null);
  const aiOn = "label" in ai;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setMode("ai");
        start(async () =>
          setResult(
            await discoverAction({ system, object, label, entityHint: entity, sample, includeValues, autoApprove }),
          ),
        );
      }}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="discover-system">System</Label>
          <Input
            id="discover-system"
            list="known-systems"
            value={system}
            onChange={(e) => setSystem(e.target.value.trim())}
            placeholder="oracle-ebs, or your own e.g. legacy-crm"
          />
          <datalist id="known-systems">
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </datalist>
          <FieldError>{result?.fieldErrors?.system}</FieldError>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="discover-object">Object</Label>
          <Input
            id="discover-object"
            value={object}
            onChange={(e) => setObject(e.target.value.trim())}
            placeholder="HZ_PARTIES, salesOrder, A_Customer…"
          />
          <FieldError>{result?.fieldErrors?.object}</FieldError>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="discover-entity">Holds (optional for AI)</Label>
          <Select id="discover-entity" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Let the AI decide</option>
            {entities.map((e) => (
              <option key={e.name} value={e.name}>
                {e.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="discover-label">Display name (optional)</Label>
        <Input
          id="discover-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Customer master"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="discover-sample">Sample</Label>
        <Textarea
          id="discover-sample"
          className="min-h-48 font-mono text-xs"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder={PLACEHOLDER}
        />
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeValues} onChange={(e) => setIncludeValues(e.target.checked)} />
          Send up to three example values per field to the AI (field names and types are always sent; values are never
          stored)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          Apply bindings the AI is at least 90% sure of when they do not conflict; review the rest
        </label>
      </div>
      <FieldError>{result?.error}</FieldError>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!aiOn || pending || !system || !object || !sample.trim()}>
          <Sparkles aria-hidden />
          {pending && mode === "ai" ? "The AI is reading the sample…" : "Propose bindings with AI"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || !system || !object || !entity}
          title={entity ? undefined : "Choose what it holds first"}
          onClick={() => {
            setMode("manual");
            start(async () => setResult(await saveObjectAction({ system, object, entity, label }, { open: true })));
          }}
        >
          Bind fields by hand
        </Button>
        <span className="text-xs text-fg-muted">
          {"label" in ai ? `Uses ${ai.label}.` : `The AI is off: ${ai.hint}`}
        </span>
      </div>
    </form>
  );
}
