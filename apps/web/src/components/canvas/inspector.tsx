"use client";

import {
  type FlowDoc,
  type Issue,
  parseExpression,
  STEP_INFO,
  type Step,
  templateExpressions,
} from "@oicr/flow-schema";
import { Plus, Shuffle, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Patch = Record<string, unknown>;

function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-fg-muted">{hint}</p>}
    </div>
  );
}

/** A JSONata (or template) field that shows parse errors as you type. */
function ExpressionField({
  id,
  label,
  value,
  onChange,
  template = false,
  rows = 2,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  template?: boolean;
  rows?: number;
  hint?: string;
  disabled?: boolean;
}) {
  const parts = template ? templateExpressions(value).map((p) => p.source) : value ? [value] : [];
  const error = parts.map((p) => (p ? parseExpression(p) : null)).find((r) => r && !r.ok)?.error?.message;
  return (
    <Field label={label} htmlFor={id} hint={error ? undefined : hint}>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={cn("min-h-0 font-mono text-xs", error && "border-danger")}
        aria-invalid={Boolean(error)}
      />
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Field>
  );
}

/** A JSON object field (adapter settings): applied while it is valid JSON. */
function JsonField({
  id,
  label,
  value,
  onChange,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const serialized = JSON.stringify(value ?? {}, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  // A change from elsewhere (undo, the AI, the JSON view) replaces what is shown.
  useEffect(() => {
    setText((t) => {
      try {
        return JSON.stringify(JSON.parse(t)) === JSON.stringify(value ?? {}) ? t : serialized;
      } catch {
        return t;
      }
    });
  }, [serialized, value]);
  return (
    <Field label={label} htmlFor={id} hint={error ? undefined : hint}>
      <Textarea
        id={id}
        value={text}
        rows={4}
        disabled={disabled}
        spellCheck={false}
        className={cn("min-h-0 font-mono text-xs", error && "border-danger")}
        aria-invalid={Boolean(error)}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value || "{}");
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Give a JSON object.");
            setError(null);
            onChange(parsed);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </Field>
  );
}

export function Inspector({
  doc,
  step,
  issues,
  connections,
  disabled,
  onChange,
  onDelete,
  onMove,
  onOpenMapper,
}: {
  doc: FlowDoc;
  step: Step;
  issues: Issue[];
  connections: { identifier: string; role: string; status: string; adapter?: string }[];
  disabled: boolean;
  onChange: (patch: Patch) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  /** Opens the visual mapper for one of the step's expressions. */
  onOpenMapper?: (field: "expression" | "request" | "body") => void;
}) {
  const s = step as Step & Record<string, any>;
  const f = (key: string) => `insp-${step.id}-${key}`;
  const text = (key: string, label: string, opts: { hint?: string; mono?: boolean; type?: string } = {}) => (
    <Field label={label} htmlFor={f(key)} hint={opts.hint}>
      <Input
        id={f(key)}
        type={opts.type ?? "text"}
        value={s[key] ?? ""}
        disabled={disabled}
        className={opts.mono ? "font-mono text-xs" : undefined}
        onChange={(e) =>
          onChange({
            [key]:
              opts.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value,
          })
        }
      />
    </Field>
  );

  return (
    <section className="flex flex-col gap-4" aria-label="Step settings">
      <div>
        <div className="text-xs text-fg-muted">{STEP_INFO[step.type].label}</div>
        <p className="text-[11px] text-fg-muted">{STEP_INFO[step.type].description}</p>
      </div>

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Problems with this step">
          {issues.map((i, n) => (
            <li
              key={`${i.code}-${n}`}
              className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-xs text-danger"
            >
              {i.message}
            </li>
          ))}
        </ul>
      )}

      {text("label", "Label")}
      {text("id", "Step id", { mono: true, hint: `Other steps read its output as $${step.id}.` })}

      {s.type === "invoke" && (
        <>
          <Field label="Connection" htmlFor={f("connection")}>
            <Select
              id={f("connection")}
              value={s.connection}
              disabled={disabled}
              onChange={(e) => onChange({ connection: e.target.value })}
            >
              <option value="">Pick a connection…</option>
              {connections
                .filter((c) => c.role !== "trigger")
                .map((c) => (
                  <option key={c.identifier} value={c.identifier}>
                    {c.identifier}
                    {c.status !== "configured" ? " (not tested)" : ""}
                  </option>
                ))}
              {s.connection && !connections.some((c) => c.identifier === s.connection) && (
                <option value={s.connection}>{s.connection} (missing)</option>
              )}
            </Select>
          </Field>
          {text("operation", "Operation", { mono: true, hint: 'e.g. "GET /orders" or "POST /orders/{id}"' })}
          {onOpenMapper && (
            <Button size="sm" variant="secondary" onClick={() => onOpenMapper("request")}>
              <Shuffle aria-hidden /> Map the request
            </Button>
          )}
          <ExpressionField
            id={f("request")}
            label="Request (JSONata)"
            value={s.request ?? ""}
            disabled={disabled}
            rows={3}
            hint='Returns { "params", "query", "headers", "body" }. Leave empty for none.'
            onChange={(v) => onChange({ request: v || undefined })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Retries" htmlFor={f("retry")} hint="On timeouts and 5xx">
              <Input
                id={f("retry")}
                type="number"
                min={1}
                max={10}
                value={s.retry?.attempts ?? ""}
                disabled={disabled}
                placeholder="none"
                onChange={(e) =>
                  onChange({
                    retry: e.target.value
                      ? { attempts: Number(e.target.value), backoffSeconds: s.retry?.backoffSeconds ?? 5 }
                      : undefined,
                  })
                }
              />
            </Field>
            {text("timeoutSeconds", "Timeout (s)", { type: "number" })}
          </div>
        </>
      )}

      {s.type === "pipeline" && (
        <>
          {(["source", "target"] as const).map((end) => (
            <div key={end} className="flex flex-col gap-3 rounded-lg border border-border p-2">
              <div className="text-xs font-medium">{end === "source" ? "Read from" : "Write to"}</div>
              <Field label="Connection" htmlFor={f(`${end}-connection`)}>
                <Select
                  id={f(`${end}-connection`)}
                  value={s[end].connection}
                  disabled={disabled}
                  onChange={(e) => onChange({ [end]: { ...s[end], connection: e.target.value } })}
                >
                  <option value="">Pick a connection…</option>
                  {connections
                    .filter((c) => c.role !== "trigger" && (!c.adapter || c.adapter === "database"))
                    .map((c) => (
                      <option key={c.identifier} value={c.identifier}>
                        {c.identifier}
                        {c.status !== "configured" ? " (not tested)" : ""}
                      </option>
                    ))}
                  {s[end].connection && !connections.some((c) => c.identifier === s[end].connection) && (
                    <option value={s[end].connection}>{s[end].connection} (missing)</option>
                  )}
                </Select>
              </Field>
              <Field label="Operation" htmlFor={f(`${end}-operation`)}>
                <Select
                  id={f(`${end}-operation`)}
                  value={s[end].operation}
                  disabled={disabled}
                  onChange={(e) => onChange({ [end]: { ...s[end], operation: e.target.value } })}
                >
                  {(end === "source" ? ["read"] : ["upsert", "insert"]).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              </Field>
              <JsonField
                id={f(`${end}-config`)}
                label="Settings (JSON)"
                value={s[end].config}
                disabled={disabled}
                hint={
                  end === "source"
                    ? '{ "table": "HZ_CUST_ACCOUNTS", "where": "LAST_UPDATE_DATE > :since", "key": "CUST_ACCOUNT_ID" } or { "sql": "select …", "key": "ID" }. The key is unique and sortable; a stopped run resumes after the last key.'
                    : '{ "table": "customers", "key": ["id"] }. Upserts update rows with the same key, so a replayed chunk never duplicates.'
                }
                onChange={(config) => onChange({ [end]: { ...s[end], config } })}
              />
              {end === "source" && (
                <ExpressionField
                  id={f("params")}
                  label="Parameters (JSONata, optional)"
                  value={s.source.params ?? ""}
                  disabled={disabled}
                  hint='Evaluated once: values for :name in the SQL, e.g. { "since": $trigger.scheduledFor }.'
                  onChange={(v) => onChange({ source: { ...s.source, params: v || undefined } })}
                />
              )}
            </div>
          ))}
          <ExpressionField
            id={f("filter")}
            label="Keep only (JSONata, optional)"
            value={s.filter ?? ""}
            disabled={disabled}
            hint="Per record, read as $record: false skips it."
            onChange={(v) => onChange({ filter: v || undefined })}
          />
          <ExpressionField
            id={f("transform")}
            label="Transform each record (JSONata, optional)"
            value={s.transform ?? ""}
            rows={4}
            disabled={disabled}
            hint="Per record ($record): the record to write. $translate, $lookupValue and $trigger work here."
            onChange={(v) => onChange({ transform: v || undefined })}
          />
          <div className="grid grid-cols-3 gap-2">
            {text("chunkSize", "Chunk size", { type: "number" })}
            {text("concurrency", "In parallel", { type: "number" })}
            {text("maxRejects", "Max rejects", { type: "number" })}
          </div>
        </>
      )}

      {s.type === "map" && onOpenMapper && (
        <Button size="sm" variant="secondary" onClick={() => onOpenMapper("expression")}>
          <Shuffle aria-hidden /> Open mapper
        </Button>
      )}
      {s.type === "map" && (
        <ExpressionField
          id={f("expression")}
          label="Expression (JSONata)"
          value={s.expression}
          rows={5}
          disabled={disabled}
          onChange={(v) => onChange({ expression: v })}
        />
      )}

      {s.type === "assign" && (
        <div className="flex flex-col gap-3">
          {(s.assignments as { variable: string; value: string }[]).map((a, i) => (
            <div key={`a${i}`} className="flex flex-col gap-2 rounded-lg border border-border p-2">
              <Field
                label="Variable"
                htmlFor={f(`var${i}`)}
                hint={
                  Object.keys(doc.variables).length
                    ? `Declared: ${Object.keys(doc.variables).join(", ")}`
                    : "Declare variables in the JSON view."
                }
              >
                <Input
                  id={f(`var${i}`)}
                  value={a.variable}
                  disabled={disabled}
                  className="font-mono text-xs"
                  onChange={(e) =>
                    onChange({
                      assignments: s.assignments.map((x: object, j: number) =>
                        j === i ? { ...x, variable: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <ExpressionField
                id={f(`val${i}`)}
                label="Value (JSONata)"
                value={a.value}
                disabled={disabled}
                onChange={(v) =>
                  onChange({
                    assignments: s.assignments.map((x: object, j: number) => (j === i ? { ...x, value: v } : x)),
                  })
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange({ assignments: [...s.assignments, { variable: "", value: "" }] })}
          >
            <Plus aria-hidden /> Add assignment
          </Button>
        </div>
      )}

      {s.type === "switch" && (
        <div className="flex flex-col gap-3">
          {(s.cases as { when: string; label?: string; steps: Step[] }[]).map((c, i) => (
            <div key={`c${i}`} className="flex flex-col gap-2 rounded-lg border border-border p-2">
              <Field label={`Branch ${i + 1} name`} htmlFor={f(`cl${i}`)}>
                <Input
                  id={f(`cl${i}`)}
                  value={c.label ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({
                      cases: s.cases.map((x: object, j: number) =>
                        j === i ? { ...x, label: e.target.value || undefined } : x,
                      ),
                    })
                  }
                />
              </Field>
              <ExpressionField
                id={f(`cw${i}`)}
                label="When (JSONata, true takes this branch)"
                value={c.when}
                disabled={disabled}
                onChange={(v) =>
                  onChange({ cases: s.cases.map((x: object, j: number) => (j === i ? { ...x, when: v } : x)) })
                }
              />
              {s.cases.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start text-danger"
                  disabled={disabled}
                  onClick={() => onChange({ cases: s.cases.filter((_: unknown, j: number) => j !== i) })}
                >
                  Remove branch{c.steps.length ? ` and its ${c.steps.length} step(s)` : ""}
                </Button>
              )}
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              onChange({ cases: [...s.cases, { when: "true", label: `Case ${s.cases.length + 1}`, steps: [] }] })
            }
          >
            <Plus aria-hidden /> Add branch
          </Button>
        </div>
      )}

      {s.type === "forEach" && (
        <>
          <ExpressionField
            id={f("over")}
            label="Over (JSONata list)"
            value={s.over}
            disabled={disabled}
            onChange={(v) => onChange({ over: v })}
          />
          {text("as", "Name each item", { mono: true, hint: `Steps inside read it as $${s.as}.` })}
        </>
      )}

      {s.type === "while" && (
        <>
          <ExpressionField
            id={f("condition")}
            label="While (JSONata)"
            value={s.condition}
            disabled={disabled}
            onChange={(v) => onChange({ condition: v })}
          />
          {text("maxIterations", "Stop after", { type: "number", hint: "Safety limit on loops." })}
        </>
      )}

      {s.type === "log" && (
        <>
          <Field label="Level" htmlFor={f("level")}>
            <Select
              id={f("level")}
              value={s.level}
              disabled={disabled}
              onChange={(e) => onChange({ level: e.target.value })}
            >
              {["debug", "info", "warn", "error"].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </Select>
          </Field>
          <ExpressionField
            id={f("message")}
            label="Message"
            template
            value={s.message}
            disabled={disabled}
            hint="Text with {{ JSONata }} parts."
            onChange={(v) => onChange({ message: v })}
          />
        </>
      )}

      {s.type === "notify" && (
        <>
          <ExpressionField
            id={f("to")}
            label="To (one per line)"
            template
            value={(s.to as string[]).join("\n")}
            disabled={disabled}
            onChange={(v) =>
              onChange({
                to: v
                  .split("\n")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
          <ExpressionField
            id={f("subject")}
            label="Subject"
            template
            value={s.subject}
            disabled={disabled}
            rows={1}
            onChange={(v) => onChange({ subject: v })}
          />
          <ExpressionField
            id={f("body")}
            label="Body"
            template
            value={s.body}
            disabled={disabled}
            rows={4}
            onChange={(v) => onChange({ body: v })}
          />
        </>
      )}

      {s.type === "wait" && text("seconds", "Seconds", { type: "number" })}

      {s.type === "throw" && (
        <>
          {text("code", "Error code", { mono: true })}
          <ExpressionField
            id={f("message")}
            label="Message"
            template
            value={s.message}
            disabled={disabled}
            onChange={(v) => onChange({ message: v })}
          />
        </>
      )}

      {s.type === "return" && (
        <>
          {text("status", "HTTP status", { type: "number" })}
          {onOpenMapper && (
            <Button size="sm" variant="secondary" onClick={() => onOpenMapper("body")}>
              <Shuffle aria-hidden /> Map the response
            </Button>
          )}
          <ExpressionField
            id={f("body")}
            label="Body (JSONata)"
            value={s.body ?? ""}
            disabled={disabled}
            rows={3}
            onChange={(v) => onChange({ body: v || undefined })}
          />
        </>
      )}

      {s.type === "scope" && (
        <p className="text-xs text-fg-muted">
          Add steps inside the frame. Steps under “On error” run when one of them fails; they can read $fault.
        </p>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onMove(-1)} aria-label="Move step up">
          ↑ Up
        </Button>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onMove(1)} aria-label="Move step down">
          ↓ Down
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto text-danger" disabled={disabled} onClick={onDelete}>
          <Trash2 aria-hidden /> Delete step
        </Button>
      </div>
    </section>
  );
}
