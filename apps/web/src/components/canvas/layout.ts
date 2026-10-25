import type { FlowDoc, Step, StepLocation } from "@oicr/flow-schema";

// Lays a FlowDoc out as a top-to-bottom tree: each list of steps is a column,
// containers (loops, scopes, switches) are frames holding their columns side
// by side. Pure and deterministic, so it is unit-tested and the AI's flows
// always look tidy without anyone placing boxes.

export const NODE_W = 248;
export const NODE_H = 60;
const GAP = 44; // vertical space between steps; the "+" sits in the middle
const PAD = 20; // inside frames
const COL_GAP = 28; // between columns in a frame
const LABEL_H = 22; // column labels (case names, "On error")
const EMPTY_H = 44;

export type LayoutNode =
  | { kind: "trigger"; id: string; x: number; y: number; w: number; h: number; doc: FlowDoc }
  | { kind: "step"; id: string; x: number; y: number; w: number; h: number; step: Step; container: boolean }
  | { kind: "frame"; id: string; x: number; y: number; w: number; h: number; step: Step }
  | { kind: "insert"; id: string; x: number; y: number; w: number; h: number; at: StepLocation; empty: boolean }
  | { kind: "label"; id: string; x: number; y: number; w: number; h: number; text: string; tone: "case" | "fault" }
  | { kind: "end"; id: string; x: number; y: number; w: number; h: number };

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  /** "frame" edges leave from the bottom of a container's frame. */
  fromFrame?: boolean;
  dashed?: boolean;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

interface Block {
  w: number;
  h: number;
  /** Node ids to connect into (entry) and out of (exit). */
  entry: string | null;
  exit: { id: string; fromFrame: boolean } | null;
  place(x: number, y: number, out: Layout): void;
}

const insertId = (at: StepLocation) => `insert:${at.parentId ?? "root"}:${at.list}:${at.index}`;

function column(steps: Step[], parentId: string | null, list: string, edit: boolean): Block {
  const blocks = steps.map((s) => stepBlock(s, edit));
  if (blocks.length === 0) {
    const at = { parentId, list, index: 0 };
    return {
      w: NODE_W,
      h: edit ? EMPTY_H : 8,
      entry: null,
      exit: null,
      place(x, y, out) {
        if (edit) out.nodes.push({ kind: "insert", id: insertId(at), x, y, w: NODE_W, h: EMPTY_H, at, empty: true });
      },
    };
  }
  const w = Math.max(...blocks.map((b) => b.w));
  const h = blocks.reduce((sum, b) => sum + b.h, 0) + GAP * (blocks.length - 1) + (edit ? GAP : 0);
  return {
    w,
    h,
    entry: blocks[0]!.entry,
    exit: blocks[blocks.length - 1]!.exit,
    place(x, y, out) {
      let cy = y;
      blocks.forEach((b, i) => {
        b.place(x + (w - b.w) / 2, cy, out);
        cy += b.h;
        const prev = b;
        const next = blocks[i + 1];
        const at = { parentId, list, index: i + 1 };
        if (next || edit) {
          if (edit)
            out.nodes.push({
              kind: "insert",
              id: insertId(at),
              x: x + w / 2 - 12,
              y: cy + GAP / 2 - 12,
              w: 24,
              h: 24,
              at,
              empty: false,
            });
          if (next && prev.exit && next.entry) {
            out.edges.push({
              id: `e:${prev.exit.id}->${next.entry}`,
              source: prev.exit.id,
              target: next.entry,
              fromFrame: prev.exit.fromFrame,
            });
          }
          cy += GAP;
        }
      });
      // An insert point before the first step, too.
      if (edit) {
        const at = { parentId, list, index: 0 };
        out.nodes.push({
          kind: "insert",
          id: insertId(at),
          x: x + w / 2 - 12,
          y: y - GAP / 2 - 12,
          w: 24,
          h: 24,
          at,
          empty: false,
        });
      }
    },
  };
}

function stepBlock(step: Step, edit: boolean): Block {
  const leaf: Block = {
    w: NODE_W,
    h: NODE_H,
    entry: step.id,
    exit: { id: step.id, fromFrame: false },
    place(x, y, out) {
      out.nodes.push({ kind: "step", id: step.id, x, y, w: NODE_W, h: NODE_H, step, container: false });
    },
  };

  const columns: { label: string | null; tone: "case" | "fault"; block: Block }[] = [];
  switch (step.type) {
    case "forEach":
    case "while":
      columns.push({ label: null, tone: "case", block: column(step.steps, step.id, "steps", edit) });
      break;
    case "scope":
      columns.push({
        label: step.onFault?.length || edit ? "Steps" : null,
        tone: "case",
        block: column(step.steps, step.id, "steps", edit),
      });
      if (step.onFault?.length || edit)
        columns.push({ label: "On error", tone: "fault", block: column(step.onFault ?? [], step.id, "onFault", edit) });
      break;
    case "switch":
      for (const [i, c] of step.cases.entries()) {
        columns.push({
          label: c.label || `When ${c.when}`,
          tone: "case",
          block: column(c.steps, step.id, `cases.${i}.steps`, edit),
        });
      }
      if (step.otherwise?.length || edit)
        columns.push({
          label: "Otherwise",
          tone: "case",
          block: column(step.otherwise ?? [], step.id, "otherwise", edit),
        });
      break;
    default:
      return leaf;
  }

  const hasLabels = columns.some((c) => c.label);
  const innerW = columns.reduce((s, c) => s + c.block.w, 0) + COL_GAP * (columns.length - 1);
  const w = Math.max(NODE_W, innerW) + PAD * 2;
  const top = NODE_H + PAD + (hasLabels ? LABEL_H : 0) + (edit ? GAP / 2 : 0);
  const h = top + Math.max(...columns.map((c) => c.block.h)) + PAD;
  const frameId = `frame:${step.id}`;
  return {
    w,
    h,
    entry: step.id,
    exit: { id: frameId, fromFrame: true },
    place(x, y, out) {
      out.nodes.push({ kind: "frame", id: frameId, x, y, w, h, step });
      out.nodes.push({
        kind: "step",
        id: step.id,
        x: x + (w - NODE_W) / 2,
        y,
        w: NODE_W,
        h: NODE_H,
        step,
        container: true,
      });
      let cx = x + (w - innerW) / 2;
      for (const [i, c] of columns.entries()) {
        const labelY = y + NODE_H + PAD;
        if (c.label)
          out.nodes.push({
            kind: "label",
            id: `label:${step.id}:${i}`,
            x: cx,
            y: labelY,
            w: c.block.w,
            h: LABEL_H,
            text: c.label,
            tone: c.tone,
          });
        c.block.place(cx, y + top, out);
        if (c.block.entry)
          out.edges.push({
            id: `e:${step.id}->${c.block.entry}`,
            source: step.id,
            target: c.block.entry,
            dashed: c.tone === "fault",
          });
        cx += c.block.w + COL_GAP;
      }
    },
  };
}

export function layoutFlow(doc: FlowDoc, opts: { edit?: boolean } = {}): Layout {
  const edit = opts.edit ?? false;
  const out: Layout = { nodes: [], edges: [], width: 0, height: 0 };
  const main = column(doc.steps, null, "steps", edit);
  // The global error handler is shown once it has steps; the editor offers a button to start one.
  const fault = doc.onFault?.length ? column(doc.onFault, null, "onFault", edit) : null;

  const mainX = 0;
  const top = NODE_H + GAP;
  out.nodes.push({
    kind: "trigger",
    id: `trigger:${doc.trigger.id}`,
    x: mainX + (main.w - NODE_W) / 2,
    y: 0,
    w: NODE_W,
    h: NODE_H,
    doc,
  });
  main.place(mainX, top, out);
  if (main.entry)
    out.edges.push({ id: `e:trigger->${main.entry}`, source: `trigger:${doc.trigger.id}`, target: main.entry });

  const endY = top + main.h + GAP;
  out.nodes.push({ kind: "end", id: "end", x: mainX + (main.w - 120) / 2, y: endY, w: 120, h: 36 });
  if (main.exit)
    out.edges.push({
      id: `e:${main.exit.id}->end`,
      source: main.exit.id,
      target: "end",
      fromFrame: main.exit.fromFrame,
    });
  else if (!main.entry) out.edges.push({ id: "e:trigger->end", source: `trigger:${doc.trigger.id}`, target: "end" });

  let width = main.w;
  let height = endY + 36;
  if (fault) {
    const fx = main.w + COL_GAP * 3;
    out.nodes.push({
      kind: "label",
      id: "label:root:onFault",
      x: fx,
      y: top - LABEL_H - 8,
      w: fault.w,
      h: LABEL_H,
      text: "On any error",
      tone: "fault",
    });
    fault.place(fx, top, out);
    width = fx + fault.w;
    height = Math.max(height, top + fault.h);
  }
  out.width = width;
  out.height = height;
  return out;
}
