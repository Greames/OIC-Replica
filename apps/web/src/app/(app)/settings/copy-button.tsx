"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />} {done ? "Copied" : label}
    </Button>
  );
}

export function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <figure aria-label={label} className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 pr-24 font-mono text-xs leading-relaxed">
        {text}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton text={text} />
      </div>
    </figure>
  );
}
