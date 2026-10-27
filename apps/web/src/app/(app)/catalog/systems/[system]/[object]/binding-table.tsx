"use client";

import { Pencil, Plus, RotateCcw, Unlink } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ActionResult } from "@/lib/errors";
import { type BindingPayload, resetBindingAction, setBindingAction } from "../../../actions";

interface Field {
  field: string;
  attribute: string;
  read: string;
  write: string;
  readOnly: boolean;
  origin: "platform" | "tenant";
  confidence: number | null;
  evidence: string | null;
  hasPlatform: boolean;
}

interface Attr {
  name: string;
  label: string;
  type: string;
}

export function BindingTable({
  system,
  object,
  attributes,
  fields,
  switchedOff,
  canBuild,
}: {
  system: string;
  object: string;
  attributes: Attr[];
  fields: Field[];
  switchedOff: string[];
  canBuild: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) after?.();
    });
  const byAttribute = new Map(fields.map((f) => [f.attribute, f]));
  const save = (payload: Omit<BindingPayload, "system" | "object">) =>
    run(
      () => setBindingAction({ system, object, ...payload }),
      () => {
        setEditing(null);
        setAdding(false);
      },
    );

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-fg-muted">
            <tr>
              <th className="py-2 pr-4 font-medium">Field</th>
              <th className="py-2 pr-4 font-medium">Attribute</th>
              <th className="py-2 pr-4 font-medium">Transforms</th>
              <th className="py-2 pr-4 font-medium">Source</th>
              {canBuild && <th className="py-2 font-medium" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {fields.map((f) =>
              editing === f.field ? (
                <tr key={f.field}>
                  <td colSpan={5} className="py-3">
                    <BindingForm
                      initial={f}
                      attributes={attributes}
                      pending={pending}
                      onCancel={() => setEditing(null)}
                      onSave={save}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={f.field}>
                  <td className="py-2 pr-4 font-mono">{f.field}</td>
                  <td className="py-2 pr-4">
                    <span className="font-mono">{f.attribute}</span>
                    {f.readOnly && <Badge className="ml-2">read only</Badge>}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-fg-muted">
                    {f.read && <div>read: {f.read}</div>}
                    {f.write && <div>write: {f.write}</div>}
                  </td>
                  <td className="py-2 pr-4">
                    {f.origin === "platform" ? (
                      <Badge>platform</Badge>
                    ) : f.confidence !== null ? (
                      <Badge className="whitespace-nowrap" title={f.evidence ?? undefined}>
                        AI · {Math.round(f.confidence * 100)}%
                      </Badge>
                    ) : (
                      <Badge>workspace</Badge>
                    )}
                  </td>
                  {canBuild && (
                    <td className="py-2 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${f.field}`}
                        onClick={() => setEditing(f.field)}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      {f.origin === "tenant" && f.hasPlatform ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Reset ${f.field}`}
                          title="Use the platform binding again"
                          onClick={() => run(() => resetBindingAction(system, object, f.field))}
                        >
                          <RotateCcw aria-hidden />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Unbind ${f.field}`}
                          onClick={() =>
                            run(() =>
                              f.origin === "tenant"
                                ? resetBindingAction(system, object, f.field)
                                : setBindingAction({ system, object, field: f.field, attribute: null }),
                            )
                          }
                        >
                          <Unlink aria-hidden />
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      {switchedOff.length > 0 && (
        <p className="mt-3 text-sm text-fg-muted">
          Platform bindings switched off:{" "}
          {switchedOff.map((field) => (
            <span key={field} className="mr-2 inline-flex items-center gap-1">
              <span className="font-mono">{field}</span>
              {canBuild && (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => run(() => resetBindingAction(system, object, field))}
                >
                  restore
                </button>
              )}
            </span>
          ))}
        </p>
      )}

      {canBuild &&
        (adding ? (
          <div className="mt-4 rounded-lg border border-border p-3">
            <BindingForm
              attributes={attributes.filter((a) => !byAttribute.has(a.name))}
              pending={pending}
              onCancel={() => setAdding(false)}
              onSave={save}
            />
          </div>
        ) : (
          <Button className="mt-4" variant="secondary" onClick={() => setAdding(true)}>
            <Plus aria-hidden /> Bind a field
          </Button>
        ))}
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={`mt-3 text-sm ${result.ok ? "text-success" : "text-danger"}`}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}
    </div>
  );
}

function BindingForm({
  initial,
  attributes,
  pending,
  onSave,
  onCancel,
}: {
  initial?: Field;
  attributes: Attr[];
  pending: boolean;
  onSave: (p: Omit<BindingPayload, "system" | "object">) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState(initial?.field ?? "");
  const [attribute, setAttribute] = useState(initial?.attribute ?? attributes[0]?.name ?? "");
  const [read, setRead] = useState(initial?.read ?? "");
  const [write, setWrite] = useState(initial?.write ?? "");
  const [readOnly, setReadOnly] = useState(initial?.readOnly ?? false);
  return (
    <form
      className="grid gap-3 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ field, attribute, read, write, readOnly });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="binding-field">Technical field</Label>
        <Input
          id="binding-field"
          value={field}
          disabled={!!initial}
          onChange={(e) => setField(e.target.value)}
          placeholder="ACCOUNT_NUMBER or entity.id"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="binding-attribute">Attribute</Label>
        <Select id="binding-attribute" value={attribute} onChange={(e) => setAttribute(e.target.value)}>
          {attributes.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name} ({a.type})
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="binding-read">Read transform (optional)</Label>
        <Input
          id="binding-read"
          className="font-mono"
          value={read}
          onChange={(e) => setRead(e.target.value)}
          placeholder='$value = "A"'
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="binding-write">Write transform (optional)</Label>
        <Input
          id="binding-write"
          className="font-mono"
          value={write}
          onChange={(e) => setWrite(e.target.value)}
          placeholder='$value ? "A" : "I"'
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
        Read only (never written back)
      </label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !field || !attribute}>
          {pending ? "Saving…" : "Save binding"}
        </Button>
      </div>
    </form>
  );
}
