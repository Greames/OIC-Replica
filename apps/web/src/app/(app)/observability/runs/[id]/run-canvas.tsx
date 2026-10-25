"use client";

import type { FlowDoc } from "@oicr/flow-schema";
import { useState } from "react";
import { Canvas, type StepStatus } from "@/components/canvas/canvas";

/** The run drawn on the integration: each step coloured by what happened. Click a step to jump to its record. */
export function RunCanvas({ doc, statuses }: { doc: FlowDoc; statuses: Record<string, StepStatus> }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Canvas
      doc={doc}
      statuses={statuses}
      selectedId={selected}
      ariaLabel="Run on the integration"
      height={420}
      onSelect={(id) => {
        setSelected(id);
        if (!id) return;
        const el = document.querySelector<HTMLDetailsElement>(`details[data-step="${CSS.escape(id)}"]`);
        if (el) {
          el.open = true;
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }}
    />
  );
}
