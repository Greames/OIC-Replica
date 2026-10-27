"use client";

import {
  EditError,
  type FlowDoc,
  findStep,
  type Issue,
  insertStep,
  locate,
  moveStep,
  newStep,
  removeStep,
  STEP_INFO,
  type Step,
  type StepLocation,
  type StepType,
  updateStep,
  validateFlow,
} from "@oicr/flow-schema";
import { AlertTriangle, CheckCircle2, MousePointerClick, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { saveDefinitionAction } from "@/app/(app)/integrations/actions";
import { Mapper, type MapperSamples } from "@/components/mapper/mapper";
import { Button } from "@/components/ui/button";
import { Canvas, STEP_ICONS } from "./canvas";
import { Inspector } from "./inspector";

const PALETTE: { group: string; types: StepType[] }[] = [
  { group: "Do", types: ["invoke", "map", "assign", "notify", "log", "wait"] },
  { group: "Control", types: ["switch", "forEach", "while", "scope"] },
  { group: "End or fail", types: ["return", "stop", "throw", "rethrow"] },
];

export function FlowEditor({
  integrationId,
  initial,
  hash,
  locked,
  connections,
  samples = { pasted: {}, run: { steps: {} } },
  lookups = [],
}: {
  integrationId: string;
  initial: FlowDoc;
  hash: string;
  locked: boolean;
  connections: { identifier: string; role: string; status: string; adapter: string }[];
  samples?: MapperSamples;
  lookups?: { name: string; domains: string[] }[];
}) {
  const router = useRouter();
  const [doc, setDoc] = useState<FlowDoc>(initial);
  const [saved, setSaved] = useState<FlowDoc>(initial);
  const [baseHash, setBaseHash] = useState(hash);
  const [history, setHistory] = useState<FlowDoc[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inserting, setInserting] = useState<StepLocation | null>(null);
  const [mapping, setMapping] = useState<{ stepId: string; field: "expression" | "request" | "body" } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(doc) !== JSON.stringify(saved);

  const validation = useMemo(
    () =>
      validateFlow(doc, {
        connections: Object.fromEntries(
          connections.map((c) => [c.identifier, { role: c.role as "invoke", adapter: c.adapter }]),
        ),
        lookups: lookups.map((l) => l.name),
      }),
    [doc, connections, lookups],
  );
  const issuesByStep = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of validation.errors) if (e.stepId) map[e.stepId] = (map[e.stepId] ?? 0) + 1;
    return map;
  }, [validation]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const apply = useCallback(
    (fn: (d: FlowDoc) => FlowDoc, select?: string | null) => {
      try {
        const next = fn(doc);
        setHistory((h) => [...h.slice(-49), doc]);
        setDoc(next);
        if (select !== undefined) setSelected(select);
        setMessage(null);
      } catch (e) {
        setMessage({ ok: false, text: e instanceof EditError ? e.message : (e as Error).message });
      }
    },
    [doc],
  );

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setDoc(prev);
    if (selected && !findStep(prev, selected)) setSelected(null);
  };

  const add = (type: StepType) => {
    if (!inserting) return;
    const step = newStep(doc, type);
    const at = inserting;
    setInserting(null);
    apply((d) => insertStep(d, at, step), step.id);
  };

  const move = (id: string, dir: -1 | 1) => {
    const at = locate(doc, id);
    if (!at) return;
    apply((d) => moveStep(d, id, { ...at, index: at.index + (dir === 1 ? 2 : -1) }), id);
  };

  const save = () =>
    start(async () => {
      const r = await saveDefinitionAction(integrationId, JSON.stringify(doc), baseHash);
      if (!r.ok) {
        setMessage({ ok: false, text: r.error ?? "Could not save." });
        return;
      }
      if (r.hash) setBaseHash(r.hash);
      setSaved(doc);
      setHistory([]);
      setMessage(
        r.errors.length === 0
          ? { ok: true, text: r.status === "configured" ? "Saved. Ready to activate." : "Saved." }
          : { ok: false, text: `Saved as a draft with ${r.errors.length} problem(s) to fix.` },
      );
      router.refresh();
    });

  const step = selected ? findStep(doc, selected)?.step : undefined;
  const stepIssues: Issue[] = step ? validation.errors.filter((e) => e.stepId === step.id) : [];
  const generalIssues = validation.errors.filter((e) => !e.stepId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {validation.errors.length === 0 ? (
          <span className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="size-4" aria-hidden /> No problems
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-sm text-danger" role="status">
            <AlertTriangle className="size-4" aria-hidden /> {validation.errors.length} problem(s)
          </span>
        )}
        {dirty && <span className="text-xs text-fg-muted">Unsaved changes</span>}
        <div className="ml-auto flex gap-2">
          {!locked && !doc.onFault?.length && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setInserting({ parentId: null, list: "onFault", index: 0 })}
              title="Steps that run when any step fails and nothing else caught it"
            >
              + Error handler
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={undo} disabled={locked || history.length === 0} aria-label="Undo">
            <Undo2 aria-hidden /> Undo
          </Button>
          <Button size="sm" onClick={save} disabled={locked || pending || !dirty}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {generalIssues.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {generalIssues.map((e, i) => (
            <li key={`g${i}`} className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-danger">
              {e.path.join(".") || "document"}: {e.message}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <div className="relative">
          <Canvas
            doc={doc}
            edit={!locked}
            selectedId={selected}
            onSelect={setSelected}
            onInsert={locked ? undefined : setInserting}
            issues={issuesByStep}
            height="min(70vh, 640px)"
          />
          {inserting && (
            <div
              role="dialog"
              aria-label="Add a step"
              className="absolute inset-x-3 top-3 z-10 rounded-xl border border-border bg-panel p-4 shadow-lg sm:left-auto sm:w-96"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium">Add a step</h3>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setInserting(null)}
                  className="rounded p-1 text-fg-muted hover:bg-muted"
                >
                  <X className="size-4" />
                </button>
              </div>
              {PALETTE.map((g) => (
                <div key={g.group} className="mb-3">
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">{g.group}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {g.types.map((t) => {
                      const Icon = STEP_ICONS[t];
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => add(t)}
                          title={STEP_INFO[t].description}
                          className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-left text-xs hover:border-accent hover:bg-accent/5"
                        >
                          <Icon className="size-3.5 text-fg-muted" aria-hidden />
                          {STEP_INFO[t].label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="rounded-xl border border-border bg-panel p-4">
          {step ? (
            <Inspector
              key={step.id}
              doc={doc}
              step={step}
              issues={stepIssues}
              connections={connections}
              disabled={locked}
              onChange={(patch) => {
                const nextId = typeof patch.id === "string" ? patch.id : step.id;
                apply((d) => updateStep(d, step.id, patch), nextId);
              }}
              onDelete={() => apply((d) => removeStep(d, step.id), null)}
              onMove={(dir) => move(step.id, dir)}
              onOpenMapper={(field) => setMapping({ stepId: step.id, field })}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-sm text-fg-muted">
              <MousePointerClick className="size-6" aria-hidden />
              {locked ? "Select a step to see its settings." : "Select a step to edit it, or press + to add one."}
            </div>
          )}
        </aside>
      </div>

      {mapping &&
        (() => {
          const target = findStep(doc, mapping.stepId)?.step as (Step & Record<string, unknown>) | undefined;
          if (!target) return null;
          const value = String(target[mapping.field] ?? "");
          const what = mapping.field === "request" ? "request" : mapping.field === "body" ? "response" : "output";
          return (
            <Mapper
              key={mapping.stepId + mapping.field}
              integrationId={integrationId}
              doc={doc}
              stepId={mapping.stepId}
              title={`Map the ${what} of "${target.label ?? target.id}"`}
              value={value}
              targetSchema={
                target.type === "map" ? (target.targetSchema as Record<string, unknown> | undefined) : undefined
              }
              samples={samples}
              lookups={lookups}
              disabled={locked}
              onChange={(v) =>
                apply((d) =>
                  updateStep(d, mapping.stepId, {
                    [mapping.field]: v || (mapping.field === "expression" ? "{}" : undefined),
                  }),
                )
              }
              onTargetSchema={
                target.type === "map"
                  ? (schema) => apply((d) => updateStep(d, mapping.stepId, { targetSchema: schema }))
                  : undefined
              }
              onClose={() => setMapping(null)}
            />
          );
        })()}

      {message && (
        <p role="status" className={`text-sm ${message.ok ? "text-success" : "text-danger"}`}>
          {message.text}
        </p>
      )}
      {locked && <p className="text-sm text-fg-muted">Deactivate the integration to edit it.</p>}
    </div>
  );
}
