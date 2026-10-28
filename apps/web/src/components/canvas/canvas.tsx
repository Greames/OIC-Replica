"use client";

import "@xyflow/react/dist/style.css";
import { type FlowDoc, STEP_INFO, type Step, type StepLocation } from "@oicr/flow-schema";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  Clock,
  CornerUpLeft,
  Database,
  FileText,
  Flag,
  GitBranch,
  type LucideIcon,
  Mail,
  Plus,
  Repeat,
  Reply,
  Shapes,
  ShieldAlert,
  Shuffle,
  SquareCode,
  Variable,
  Webhook,
  Zap,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { type LayoutNode, layoutFlow } from "./layout";

export const STEP_ICONS: Record<Step["type"], LucideIcon> = {
  invoke: Zap,
  map: Shuffle,
  assign: Variable,
  switch: GitBranch,
  forEach: Repeat,
  while: Repeat,
  scope: Shapes,
  log: FileText,
  notify: Mail,
  wait: Clock,
  throw: AlertTriangle,
  rethrow: CornerUpLeft,
  stop: Ban,
  return: Reply,
  js: SquareCode,
  pipeline: Database,
};

/** One line saying what a step does, for the box on the canvas. */
export function stepSummary(s: Step): string {
  switch (s.type) {
    case "invoke":
      return s.connection ? `${s.connection} · ${s.operation}` : "Pick a connection";
    case "map":
      return `→ $${s.id}`;
    case "assign":
      return s.assignments.map((a) => `$vars.${a.variable || "?"}`).join(", ");
    case "switch":
      return `${s.cases.length + (s.otherwise ? 1 : 0)} branches`;
    case "forEach":
      return `each $${s.as} in ${s.over}`;
    case "while":
      return `while ${s.condition}`;
    case "scope":
      return s.onFault?.length ? "with error handler" : "group";
    case "log":
      return s.message || "(empty)";
    case "notify":
      return `to ${s.to.join(", ") || "?"}`;
    case "wait":
      return `${s.seconds} s`;
    case "throw":
      return s.code;
    case "return":
      return `HTTP ${s.status}`;
    case "pipeline":
      return s.source.connection && s.target.connection
        ? `${s.source.connection} → ${s.target.connection} · ${s.chunkSize}/chunk`
        : "Pick a source and a target";
    default:
      return STEP_INFO[s.type].label;
  }
}

export interface StepStatus {
  /** failed if any execution failed. */
  status: "succeeded" | "failed" | "skipped";
  /** Executions (loops run a step many times) and how many failed. */
  runs: number;
  failed: number;
}

export interface CanvasProps {
  doc: FlowDoc;
  edit?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onInsert?: (at: StepLocation) => void;
  /** Problems per step id (from validateFlow). */
  issues?: Record<string, number>;
  /** Run replay: what happened to each step. */
  statuses?: Record<string, StepStatus>;
  /** Proposal review: steps the AI added or changed. */
  highlights?: Record<string, "added" | "changed" | "moved">;
  height?: number | string;
  ariaLabel?: string;
}

type NodeData = {
  layout: LayoutNode;
  selected: boolean;
  issues: number;
  status?: StepStatus;
  /** Showing a run: steps without a status did not run. */
  replay: boolean;
  highlight?: "added" | "changed" | "moved";
  onInsert?: (at: StepLocation) => void;
};

const handles = (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
    <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
  </>
);

function StepNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.layout as Extract<LayoutNode, { kind: "step" }>;
  const Icon = STEP_ICONS[n.step.type];
  const st = data.status;
  return (
    <div
      data-step-id={n.step.id}
      data-status={st?.status ?? (data.replay ? "not-run" : undefined)}
      className={cn(
        "flex h-full w-full cursor-pointer items-center gap-3 rounded-xl border bg-panel px-3 shadow-sm transition-shadow hover:shadow",
        data.selected ? "border-accent ring-2 ring-accent/40" : "border-border",
        data.highlight === "added" && "ring-2 ring-success/60",
        data.highlight === "changed" && "ring-2 ring-accent/60",
        st?.status === "failed" && "border-danger bg-danger/5",
        st?.status === "succeeded" && "border-success/60",
        data.replay && !st && "opacity-45",
      )}
    >
      {handles}
      <div className={cn("rounded-lg p-1.5", n.container ? "bg-accent/10 text-accent" : "bg-muted text-fg-muted")}>
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{n.step.label || STEP_INFO[n.step.type].label}</div>
        <div className="truncate font-mono text-[11px] text-fg-muted">{stepSummary(n.step)}</div>
      </div>
      {data.issues > 0 && (
        <span
          title={`${data.issues} problem(s)`}
          className="flex items-center gap-0.5 rounded-md bg-danger/15 px-1.5 py-0.5 text-[11px] font-medium text-danger"
        >
          <ShieldAlert className="size-3" aria-hidden />
          {data.issues}
        </span>
      )}
      {st && (
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium",
            st.status === "failed"
              ? "bg-danger/15 text-danger"
              : st.status === "skipped"
                ? "bg-muted text-fg-muted"
                : "bg-success/15 text-success",
          )}
        >
          {st.status === "failed"
            ? st.failed < st.runs
              ? `${st.failed}/${st.runs} failed`
              : `failed${st.runs > 1 ? ` ×${st.runs}` : ""}`
            : `${st.status === "skipped" ? "skipped" : "ok"}${st.runs > 1 ? ` ×${st.runs}` : ""}`}
        </span>
      )}
      {data.highlight && !st && (
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium",
            data.highlight === "added" ? "bg-success/15 text-success" : "bg-accent/15 text-accent",
          )}
        >
          {data.highlight === "added" ? "new" : data.highlight}
        </span>
      )}
    </div>
  );
}

function TriggerNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.layout as Extract<LayoutNode, { kind: "trigger" }>;
  const t = n.doc.trigger;
  const Icon = t.type === "schedule" ? CalendarClock : Webhook;
  return (
    <div
      className={cn(
        "flex h-full w-full items-center gap-3 rounded-full border-2 border-accent/50 bg-accent/5 px-4",
        data.selected && "ring-2 ring-accent/40",
      )}
    >
      {handles}
      <Icon className="size-4 text-accent" aria-hidden />
      <div className="min-w-0">
        <div className="text-sm font-medium">
          {t.type === "schedule"
            ? "On a schedule"
            : t.type === "http"
              ? `When called: ${t.method} ${t.path}`
              : "When triggered"}
        </div>
        {t.type === "http" && (
          <div className="text-[11px] text-fg-muted">
            {t.sync ? "caller waits for a response" : "answers 202 right away"}
          </div>
        )}
      </div>
    </div>
  );
}

function FrameNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.layout as Extract<LayoutNode, { kind: "frame" }>;
  return (
    <div
      className={cn(
        "h-full w-full rounded-2xl border border-dashed",
        n.step.type === "scope" ? "border-fg-muted/30 bg-muted/30" : "border-accent/30 bg-accent/[0.03]",
      )}
    >
      {handles}
    </div>
  );
}

function InsertNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.layout as Extract<LayoutNode, { kind: "insert" }>;
  const where = `${n.at.parentId ?? "top level"} ${n.at.list} ${n.at.index}`;
  if (n.empty) {
    return (
      <button
        type="button"
        aria-label={`Add a step here (${where})`}
        onClick={(e) => {
          e.stopPropagation();
          data.onInsert?.(n.at);
        }}
        className="flex h-full w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-fg-muted/40 text-xs text-fg-muted hover:border-accent hover:text-accent"
      >
        <Plus className="size-3.5" aria-hidden /> Add a step
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Insert a step (${where})`}
      onClick={(e) => {
        e.stopPropagation();
        data.onInsert?.(n.at);
      }}
      className="flex h-full w-full items-center justify-center rounded-full border border-border bg-panel text-fg-muted opacity-60 shadow-sm hover:border-accent hover:text-accent hover:opacity-100 focus-visible:opacity-100"
    >
      <Plus className="size-3.5" aria-hidden />
    </button>
  );
}

function LabelNode({ data }: NodeProps<Node<NodeData>>) {
  const n = data.layout as Extract<LayoutNode, { kind: "label" }>;
  return (
    <div
      className={cn("truncate text-center text-xs font-medium", n.tone === "fault" ? "text-danger" : "text-fg-muted")}
      title={n.text}
    >
      {n.text}
    </div>
  );
}

function EndNode() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-1.5 rounded-full border border-border bg-muted text-xs text-fg-muted">
      <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
      <Flag className="size-3" aria-hidden /> End
    </div>
  );
}

const nodeTypes = {
  step: StepNode,
  trigger: TriggerNode,
  frame: FrameNode,
  insert: InsertNode,
  label: LabelNode,
  end: EndNode,
};

function Inner({
  doc,
  edit,
  selectedId,
  onSelect,
  onInsert,
  issues = {},
  statuses,
  highlights = {},
  height = 560,
  ariaLabel,
}: CanvasProps) {
  const layout = useMemo(() => layoutFlow(doc, { edit }), [doc, edit]);
  const { fitView } = useReactFlow();

  const nodes: Node<NodeData>[] = useMemo(
    () =>
      layout.nodes.map((l) => ({
        id: l.id,
        type: l.kind,
        position: { x: l.x, y: l.y },
        width: l.w,
        height: l.h,
        draggable: false,
        connectable: false,
        selectable: l.kind === "step",
        zIndex: l.kind === "frame" ? 0 : l.kind === "insert" ? 3 : 2,
        data: {
          layout: l,
          selected: l.kind === "step" && l.id === selectedId,
          issues: l.kind === "step" ? (issues[l.id] ?? 0) : l.kind === "trigger" ? (issues[l.doc.trigger.id] ?? 0) : 0,
          status: l.kind === "step" && statuses ? statuses[l.id] : undefined,
          replay: statuses !== undefined,
          highlight: l.kind === "step" ? highlights[l.id] : undefined,
          onInsert,
        },
        style: { width: l.w, height: l.h },
      })),
    [layout, selectedId, issues, statuses, highlights, onInsert],
  );
  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        style: {
          strokeDasharray: e.dashed ? "4 4" : undefined,
          stroke: e.dashed ? "var(--danger)" : "var(--fg-muted)",
          strokeWidth: 1.25,
          opacity: 0.7,
        },
        zIndex: 1,
      })),
    [layout],
  );

  // Refit when the shape changes (steps added or removed), not on every selection.
  const shape = layout.nodes.length;
  useEffect(() => {
    const t = setTimeout(() => {
      void fitView({ padding: 0.12, maxZoom: 1, duration: 150 });
    }, 30);
    return () => clearTimeout(t);
  }, [shape, fitView]);

  return (
    <figure
      style={{ height }}
      className="m-0 rounded-xl border border-border bg-bg"
      aria-label={ariaLabel ?? "Integration canvas"}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.type === "step") onSelect?.(node.id);
        }}
        onPaneClick={() => onSelect?.(null)}
      >
        <Background gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </figure>
  );
}

/** The integration as a diagram: edit mode adds "+" insert points; view mode can show run results or AI changes. */
export function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
