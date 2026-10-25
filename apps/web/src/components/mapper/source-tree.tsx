"use client";

import { pathExpression, type Shape } from "@oicr/flow-schema";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<Shape["type"], string> = {
  object: "{ }",
  array: "list",
  string: "text",
  number: "number",
  boolean: "yes/no",
  null: "empty",
  any: "any",
};

function children(shape: Shape): { name: string; shape: Shape; optional?: boolean }[] {
  if (shape.type === "object") return shape.fields ?? [];
  if (shape.type === "array" && shape.items?.type === "object") return shape.items.fields ?? [];
  return [];
}

function Node({
  root,
  segments,
  name,
  shape,
  depth,
  optional,
  onPick,
}: {
  root: string;
  segments: string[];
  name: string;
  shape: Shape;
  depth: number;
  optional?: boolean;
  onPick: (path: string, name: string) => void;
}) {
  const kids = children(shape);
  const [open, setOpen] = useState(depth < 3);
  const path = pathExpression(root, segments);
  return (
    <li>
      <div className="group flex items-center gap-1" style={{ paddingLeft: depth * 12 }}>
        {kids.length > 0 ? (
          <button
            type="button"
            aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
            onClick={() => setOpen(!open)}
            className="rounded p-0.5 text-fg-muted hover:bg-muted"
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", path);
            e.dataTransfer.setData("application/x-oicr-name", name);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => onPick(path, name)}
          title={`${path}\nClick to map into the selected target field, or drag onto one.`}
          data-path={path}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/10"
        >
          <span className={cn("truncate font-medium", depth === 0 && "font-mono")}>{name}</span>
          <span className="shrink-0 text-[10px] text-fg-muted">
            {TYPE_LABEL[shape.type]}
            {optional ? "?" : ""}
          </span>
          {shape.example !== undefined && (
            <span className="truncate text-[10px] text-fg-muted/80">{String(shape.example)}</span>
          )}
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <Node
              key={k.name}
              root={root}
              segments={[...segments, k.name]}
              name={k.name}
              shape={k.shape}
              depth={depth + 1}
              optional={k.optional}
              onPick={onPick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SourceTree({
  root,
  label,
  shape,
  onPick,
}: {
  root: string;
  label: string;
  shape: Shape;
  onPick: (path: string, name: string) => void;
}) {
  return (
    <ul aria-label={`Source ${label}`}>
      <Node root={root} segments={[]} name={label} shape={shape} depth={0} onPick={onPick} />
    </ul>
  );
}
