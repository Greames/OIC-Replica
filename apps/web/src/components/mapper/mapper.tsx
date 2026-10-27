"use client";

import {
  evaluateExpression,
  type FlowDoc,
  inferShape,
  parseExpression,
  parseMapping,
  printMapping,
  type Shape,
  type Source,
  shapeFromJsonSchema,
  shapeToJsonSchema,
  sourcesAt,
} from "@oicr/flow-schema";
import { AlertTriangle, Braces, Clipboard, List, Play, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { setSampleAction, testExpressionAction } from "@/app/(app)/integrations/mapper-actions";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { applyTemplate, FUNCTION_GROUPS } from "./functions";
import {
  addField,
  countMapped,
  exprFor,
  findField,
  isMapped,
  newUid,
  removeField,
  requiredUnmapped,
  toMapping,
  toUI,
  type UIField,
  updateField,
} from "./model";
import { SourceTree } from "./source-tree";

export interface MapperSamples {
  pasted: Record<string, unknown>;
  run: { trigger?: unknown; steps: Record<string, unknown> };
}

export interface MapperProps {
  integrationId: string;
  doc: FlowDoc;
  stepId: string;
  title: string;
  value: string;
  targetSchema?: Record<string, unknown>;
  samples: MapperSamples;
  lookups: { name: string; domains: string[] }[];
  disabled: boolean;
  onChange: (value: string) => void;
  /** Map steps only: replace the target schema. */
  onTargetSchema?: (schema: Record<string, unknown> | undefined) => void;
  onClose: () => void;
}

const INVOKE_SHAPE: Shape = {
  type: "object",
  fields: [
    { name: "status", shape: { type: "number" } },
    { name: "headers", shape: { type: "object", fields: [] } },
    { name: "body", shape: { type: "any" } },
  ],
};
const FAULT_SAMPLE = { code: "http_500", message: "The API answered 500.", stepId: "step", details: {} };

function sampleFor(s: Source, doc: FlowDoc, samples: MapperSamples): unknown {
  if (s.kind === "trigger")
    return (
      samples.pasted.trigger ??
      samples.run.trigger ??
      (s.triggerType === "schedule" ? { scheduledFor: new Date().toISOString() } : undefined)
    );
  if (s.kind === "vars")
    return Object.fromEntries(Object.entries(doc.variables).map(([k, v]) => [k, v.initial ?? null]));
  if (s.kind === "step") return samples.pasted[s.name] ?? samples.run.steps[s.name];
  if (s.kind === "fault") return FAULT_SAMPLE;
  return undefined;
}

function shapeFor(s: Source, doc: FlowDoc, sample: unknown): Shape {
  if (sample !== undefined) return inferShape(sample);
  if (s.kind === "trigger" && doc.trigger.type === "http" && doc.trigger.requestSchema)
    return shapeFromJsonSchema(doc.trigger.requestSchema);
  if (s.kind === "step" && s.stepType === "invoke") return INVOKE_SHAPE;
  return { type: "any" };
}

export function Mapper(props: MapperProps) {
  const { stepId, samples: initialSamples, lookups, disabled } = props;
  // Only this step changes while the mapper is open, so what it can read is fixed.
  const [doc] = useState(props.doc);
  const sources = useMemo(() => sourcesAt(doc, stepId) ?? [], [doc, stepId]);
  const [samples, setSamples] = useState(initialSamples);
  const [bindings, setBindings] = useState<Record<string, unknown>>({});
  const targetShape = props.targetSchema ? shapeFromJsonSchema(props.targetSchema) : undefined;
  const [parsed] = useState(() => parseMapping(props.value));
  const [mode, setMode] = useState<"fields" | "code">(parsed ? "fields" : "code");
  const [fields, setFields] = useState<UIField[]>(() => toUI(parsed ?? [], targetShape));
  const [code, setCode] = useState(props.value);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pasting, setPasting] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [fnFilter, setFnFilter] = useState("");
  const [testInput, setTestInput] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  // Sample values per source; loop items come from evaluating the loop's list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const b: Record<string, unknown> = {};
      for (const s of sources) {
        if (s.kind === "loop") {
          try {
            const list = await evaluateExpression(s.over, b.trigger ?? {}, b);
            b[s.name] = Array.isArray(list) ? list[0] : list;
          } catch {
            b[s.name] = undefined;
          }
        } else b[s.name] = sampleFor(s, doc, samples);
      }
      if (!cancelled) setBindings(b);
    })();
    return () => {
      cancelled = true;
    };
  }, [sources, doc, samples]);

  const commit = (next: UIField[]) => {
    setFields(next);
    const text = printMapping(toMapping(next));
    setCode(text);
    props.onChange(text);
  };

  const setExprOf = (uid: string, path: string) => {
    const row = findField(fields, uid);
    if (!row) return;
    if (row.each !== undefined && !row.each.trim())
      commit(updateField(fields, uid, (f) => ({ ...f, each: exprFor(fields, uid, path) })));
    else if (row.fields) addInto(uid, path);
    else commit(updateField(fields, uid, (f) => ({ ...f, expr: exprFor(fields, uid, path) })));
  };

  const keyFrom = (path: string) => {
    const last = path.split(".").pop() ?? "field";
    return last.replace(/^\$|`/g, "") || "field";
  };

  const addInto = (parent: string | null, path: string) => {
    const uid = newUid();
    const tentative = addField(fields, parent, { uid, key: keyFrom(path), expr: "" });
    commit(updateField(tentative, uid, (f) => ({ ...f, expr: exprFor(tentative, uid, path) })));
    setSelected(uid);
  };

  const pick = (path: string) => {
    if (disabled) return;
    if (mode === "code") {
      setCode((c) => `${c}${c.endsWith(" ") || !c ? "" : " "}${path}`);
      return;
    }
    setNote(null);
    if (selected && findField(fields, selected)) setExprOf(selected, path);
    else addInto(null, path);
  };

  const applyFn = (template: string) => {
    if (disabled) return;
    if (mode === "code") {
      setCode((c) => applyTemplate(template, c));
      return;
    }
    const row = selected ? findField(fields, selected) : undefined;
    if (!row || row.fields) {
      setNote("Select a target field to apply a function to it.");
      return;
    }
    commit(updateField(fields, row.uid, (f) => ({ ...f, expr: applyTemplate(template, f.expr ?? "") })));
  };

  const switchMode = (m: "fields" | "code") => {
    if (m === mode) return;
    if (m === "code") {
      setMode("code");
      return;
    }
    const p = parseMapping(code);
    if (!p) {
      setNote("This expression is not a plain list of fields, so it can only be edited as code.");
      return;
    }
    setFields(toUI(p, targetShape));
    setMode("fields");
    setNote(null);
  };

  const missing = mode === "fields" ? requiredUnmapped(fields) : [];
  const codeError = mode === "code" && code.trim() ? parseExpression(code).error?.message : undefined;
  const expression = mode === "fields" ? printMapping(toMapping(fields)) : code;

  const sampleJson = useMemo(
    () => JSON.stringify(Object.fromEntries(Object.entries(bindings).filter(([, v]) => v !== undefined)), null, 2),
    [bindings],
  );

  const runTest = () =>
    start(async () => {
      const r = await testExpressionAction(props.integrationId, expression, testInput ?? sampleJson);
      setTestResult(
        r.ok ? { ok: true, text: JSON.stringify(r.result, null, 2) } : { ok: false, text: r.error ?? "Failed." },
      );
    });

  const savePaste = (source: string) =>
    start(async () => {
      const r = await setSampleAction(props.integrationId, source, pasteText);
      if (!r.ok) {
        setNote(r.error ?? "Could not save the sample.");
        return;
      }
      setSamples((s) => ({ ...s, pasted: { ...s.pasted, [source]: JSON.parse(pasteText) } }));
      setPasting(null);
      setPasteText("");
      setTestInput(null);
    });

  const clearPaste = (source: string) =>
    start(async () => {
      await setSampleAction(props.integrationId, source, null);
      setSamples((s) => {
        const { [source]: _drop, ...rest } = s.pasted;
        return { ...s, pasted: rest };
      });
      setTestInput(null);
    });

  const setTargetFromSample = () => {
    try {
      const schema = shapeToJsonSchema(inferShape(JSON.parse(pasteText)));
      props.onTargetSchema?.(schema);
      setFields(toUI(toMapping(fields), shapeFromJsonSchema(schema)));
      setPasting(null);
      setPasteText("");
      setNote(null);
    } catch (e) {
      setNote(`Not valid JSON: ${(e as Error).message}`);
    }
  };

  const row = (f: UIField, depth: number, parentList: boolean): React.ReactNode => {
    const isList = f.each !== undefined;
    const isObject = !isList && Boolean(f.fields);
    const active = selected === f.uid;
    const unmapped = f.required && !isMapped(f);
    return (
      <li key={f.uid}>
        <fieldset
          aria-label={`Target ${f.key}`}
          data-selected={active || undefined}
          onFocusCapture={() => setSelected(f.uid)}
          onDragOver={(e) => {
            if (!disabled) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            const path = e.dataTransfer.getData("text/plain");
            if (path) {
              setSelected(f.uid);
              setExprOf(f.uid, path);
            }
          }}
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5",
            active ? "border-accent bg-accent/5" : "border-transparent hover:border-border",
          )}
          style={{ marginLeft: depth * 16 }}
        >
          {isList ? (
            <List className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
          ) : isObject ? (
            <Braces className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
          ) : null}
          <Input
            aria-label={`Name of target ${f.key}`}
            value={f.key}
            disabled={disabled}
            onFocus={() => setSelected(f.uid)}
            onChange={(e) => commit(updateField(fields, f.uid, (x) => ({ ...x, key: e.target.value })))}
            className="h-7 w-32 shrink-0 px-2 text-xs font-medium"
          />
          {f.required && (
            <span className={cn("text-[10px]", unmapped ? "font-medium text-danger" : "text-fg-muted")}>required</span>
          )}
          {isList && <span className="text-[11px] text-fg-muted">for each item of</span>}
          {!isObject && (
            <Input
              aria-label={isList ? `List source of ${f.key}` : `Expression of ${f.key}`}
              value={isList ? (f.each ?? "") : (f.expr ?? "")}
              disabled={disabled}
              placeholder={
                isList
                  ? "pick a list on the left"
                  : parentList
                    ? "pick a field (relative to the item)"
                    : "pick a source field, or type"
              }
              onFocus={() => setSelected(f.uid)}
              onChange={(e) =>
                commit(
                  updateField(fields, f.uid, (x) =>
                    isList ? { ...x, each: e.target.value } : { ...x, expr: e.target.value },
                  ),
                )
              }
              className={cn(
                "h-7 min-w-40 flex-1 px-2 font-mono text-xs",
                !isList && f.expr?.trim() && parseExpression(f.expr).error && "border-danger",
              )}
            />
          )}
          {f.type && !isObject && !isList && <span className="text-[10px] text-fg-muted">{f.type}</span>}
          {(isObject || isList) && !disabled && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                const uid = newUid();
                commit(addField(fields, f.uid, { uid, key: "field", expr: "" }));
                setSelected(uid);
              }}
            >
              <Plus aria-hidden /> field
            </Button>
          )}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${f.key}`}
              onClick={(e) => {
                e.stopPropagation();
                commit(removeField(fields, f.uid));
                if (selected === f.uid) setSelected(null);
              }}
              className="ml-auto rounded p-1 text-fg-muted hover:bg-muted"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </fieldset>
        {f.fields && f.fields.length > 0 && (
          <ul className="flex flex-col gap-0.5">{f.fields.map((c) => row(c, depth + 1, isList || parentList))}</ul>
        )}
      </li>
    );
  };

  const addTop = (kind: "field" | "object" | "list") => {
    const uid = newUid();
    const parent = selected && findField(fields, selected)?.fields ? selected : null;
    const field: UIField =
      kind === "field"
        ? { uid, key: "field", expr: "" }
        : kind === "object"
          ? { uid, key: "object", fields: [] }
          : { uid, key: "items", each: "", wrap: true, fields: [] };
    commit(addField(fields, parent, field));
    setSelected(uid);
  };

  const q = fnFilter.trim().toLowerCase();
  const groups = [
    ...FUNCTION_GROUPS,
    ...(lookups.length
      ? [
          {
            group: "Lookups",
            functions: lookups.map((l) => ({
              name: l.name,
              template: `$lookupValue("${l.name}", "${l.domains[0]}", {}, "${l.domains[1]}")`,
              description: `${l.domains[0]} → ${l.domains[1]} (domains: ${l.domains.join(", ")})`,
            })),
          },
        ]
      : []),
  ]
    .map((g) => ({
      ...g,
      functions: g.functions.filter((f) => !q || `${f.name} ${f.description}`.toLowerCase().includes(q)),
    }))
    .filter((g) => g.functions.length);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Mapper"
        className="flex w-full max-w-[1400px] flex-col overflow-hidden border border-border bg-bg shadow-xl sm:rounded-xl"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h2 className="font-medium">{props.title}</h2>
          <span className="text-xs text-fg-muted" role="status">
            {mode === "fields" ? `${countMapped(fields)} field(s) mapped` : "Code"}
            {missing.length > 0 && (
              <span className="ml-2 text-danger">
                · {missing.length} required not mapped: {missing.join(", ")}
              </span>
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-lg border border-border p-0.5" role="tablist" aria-label="View">
              {(["fields", "code"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => switchMode(m)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs",
                    mode === m ? "bg-muted font-medium" : "text-fg-muted",
                  )}
                >
                  {m === "fields" ? "Fields" : "Code"}
                </button>
              ))}
            </div>
            <Button size="sm" onClick={props.onClose}>
              Done
            </Button>
          </div>
        </header>

        {note && (
          <p role="alert" className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-xs">
            <AlertTriangle className="size-3.5" aria-hidden /> {note}
          </p>
        )}

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(240px,1fr)_minmax(340px,1.6fr)_minmax(240px,0.9fr)] lg:overflow-hidden">
          {/* Sources */}
          <section
            aria-label="Sources"
            className="flex flex-col border-b lg:min-h-0 border-border lg:border-r lg:border-b-0"
          >
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-fg-muted">
              Sources · click or drag a field
            </div>
            <div className="space-y-3 p-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {sources.map((s) => {
                const sample = bindings[s.name];
                const shape = shapeFor(s, doc, sample);
                const canPaste = s.kind === "trigger" || s.kind === "step";
                const label = s.kind === "step" && s.label ? `$${s.name} · ${s.label}` : `$${s.name}`;
                return (
                  <div key={s.name} className="rounded-lg border border-border p-1.5">
                    <SourceTree root={s.name} label={label} shape={shape} onPick={pick} />
                    {canPaste && !disabled && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 px-1 text-[11px] text-fg-muted">
                        {sample === undefined && <span>No sample yet.</span>}
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => {
                            setPasting(s.name);
                            setPasteText(sample === undefined ? "" : JSON.stringify(sample, null, 2));
                          }}
                        >
                          <Clipboard className="mr-0.5 inline size-3" aria-hidden />
                          {sample === undefined ? "Paste a sample" : "Edit sample"}
                        </button>
                        {s.name in samples.pasted && (
                          <button type="button" className="hover:underline" onClick={() => clearPaste(s.name)}>
                            Clear
                          </button>
                        )}
                      </div>
                    )}
                    {pasting === s.name && (
                      <div className="mt-2 flex flex-col gap-2 px-1">
                        <Textarea
                          aria-label={`Sample for ${s.name}`}
                          value={pasteText}
                          onChange={(e) => setPasteText(e.target.value)}
                          rows={6}
                          className="font-mono text-xs"
                          placeholder='{ "orders": [ { "id": "A1" } ] }'
                        />
                        <div className="flex gap-2">
                          <Button size="sm" disabled={pending} onClick={() => savePaste(s.name)}>
                            Use sample
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setPasting(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Target */}
          <section
            aria-label="Target"
            className="flex flex-col border-b lg:min-h-0 border-border lg:border-r lg:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
              <span className="mr-auto text-xs font-medium text-fg-muted">Target</span>
              {mode === "fields" && !disabled && (
                <>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => addTop("field")}>
                    <Plus aria-hidden /> Field
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => addTop("object")}>
                    <Braces aria-hidden /> Object
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => addTop("list")}>
                    <List aria-hidden /> List
                  </Button>
                </>
              )}
              {props.onTargetSchema && !disabled && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setPasting("__target");
                    setPasteText("");
                  }}
                >
                  Target from sample
                </Button>
              )}
            </div>
            {pasting === "__target" && (
              <div className="flex flex-col gap-2 border-b border-border p-3">
                <p className="text-xs text-fg-muted">
                  Paste an example of what this step should produce. Its fields show up here to map.
                </p>
                <Textarea
                  aria-label="Target sample"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={5}
                  className="font-mono text-xs"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={setTargetFromSample}>
                    Use as target
                  </Button>
                  {props.targetSchema && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        props.onTargetSchema?.(undefined);
                        setFields(toUI(toMapping(fields)));
                        setPasting(null);
                      }}
                    >
                      Remove target schema
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setPasting(null)}>
                    <X aria-hidden /> Cancel
                  </Button>
                </div>
              </div>
            )}
            <div className="p-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {mode === "fields" ? (
                fields.length === 0 ? (
                  <p className="p-4 text-center text-sm text-fg-muted">
                    Click a source field to add it here, or add a field above.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5" aria-label="Target fields">
                    {fields.map((f) => row(f, 0, false))}
                  </ul>
                )
              ) : (
                <div className="flex h-full flex-col gap-1">
                  <Textarea
                    aria-label="Mapping code"
                    value={code}
                    disabled={disabled}
                    spellCheck={false}
                    onChange={(e) => {
                      setCode(e.target.value);
                      props.onChange(e.target.value);
                    }}
                    className={cn("min-h-64 flex-1 font-mono text-xs", codeError && "border-danger")}
                  />
                  {codeError && <p className="text-xs text-danger">{codeError}</p>}
                </div>
              )}
            </div>
          </section>

          {/* Functions + test */}
          <section aria-label="Functions and test" className="flex flex-col lg:min-h-0">
            <div className="border-b border-border px-3 py-2">
              <Input
                aria-label="Find a function"
                placeholder="Functions…"
                value={fnFilter}
                onChange={(e) => setFnFilter(e.target.value)}
                className="h-7 text-xs"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-2 lg:max-h-none lg:min-h-0 lg:flex-1">
              {groups.map((g) => (
                <div key={g.group} className="mb-2">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-muted">{g.group}</div>
                  <div className="flex flex-wrap gap-1">
                    {g.functions.map((fn) => (
                      <button
                        key={`${g.group}-${fn.name}`}
                        type="button"
                        title={`${fn.description}\n${fn.template}`}
                        onClick={() => applyFn(fn.template)}
                        className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] hover:border-accent hover:bg-accent/5"
                      >
                        {fn.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2 border-t border-border p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">Test</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto h-7 text-xs"
                  disabled={pending || !expression.trim()}
                  onClick={runTest}
                >
                  <Play aria-hidden /> Run test
                </Button>
              </div>
              <details>
                <summary className="cursor-pointer text-[11px] text-fg-muted">Sample input</summary>
                <Textarea
                  aria-label="Test input"
                  value={testInput ?? sampleJson}
                  onChange={(e) => setTestInput(e.target.value)}
                  rows={6}
                  className="mt-1 font-mono text-[11px]"
                />
              </details>
              {testResult && (
                <figure aria-label="Test result">
                  <pre
                    className={cn(
                      "max-h-56 overflow-auto rounded-lg border p-2 font-mono text-[11px]",
                      testResult.ok ? "border-border bg-muted/40" : "border-danger/40 bg-danger/5 text-danger",
                    )}
                  >
                    {testResult.text}
                  </pre>
                </figure>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
