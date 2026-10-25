"use client";

import type { Issue } from "@oicr/flow-schema";
import { AlertTriangle, CheckCircle2, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { saveDefinitionAction } from "../actions";

function pathText(path: (string | number)[]) {
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
    .join("")
    .replace(/^\./, "");
}

export function DefinitionEditor({
  id,
  initial,
  hash,
  initialErrors,
  locked,
  templates,
}: {
  id: string;
  initial: unknown;
  hash: string;
  initialErrors: Issue[];
  locked: boolean;
  templates: { name: string; doc: unknown }[];
}) {
  const router = useRouter();
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [baseHash, setBaseHash] = useState(hash);
  const [errors, setErrors] = useState<Issue[]>(initialErrors);
  const [warnings, setWarnings] = useState<Issue[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = text !== JSON.stringify(initial, null, 2);

  const save = () =>
    start(async () => {
      const r = await saveDefinitionAction(id, text, baseHash);
      if (!r.ok) {
        setMessage({ ok: false, text: r.error ?? "Could not save." });
        return;
      }
      if (r.hash) setBaseHash(r.hash);
      setErrors(r.errors);
      setWarnings(r.warnings);
      setMessage(
        r.errors.length === 0
          ? { ok: true, text: r.status === "configured" ? "Saved. Ready to activate." : "Saved." }
          : { ok: false, text: `Saved as a draft with ${r.errors.length} problem(s) to fix.` },
      );
      router.refresh();
    });

  const format = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
      setMessage(null);
    } catch (e) {
      setMessage({ ok: false, text: `Not valid JSON: ${(e as Error).message}` });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {!locked && templates.length > 0 && (
          <div className="flex items-center gap-2">
            <Wand2 className="size-4 text-fg-muted" aria-hidden />
            <Select
              aria-label="Start from a template"
              className="h-8 w-auto"
              value=""
              onChange={(e) => {
                const t = templates[Number(e.target.value)];
                if (t) setText(JSON.stringify(t.doc, null, 2));
              }}
            >
              <option value="" disabled>
                Start from a template…
              </option>
              {templates.map((t, i) => (
                <option key={t.name} value={i}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={format} disabled={locked}>
            Format
          </Button>
          <Button size="sm" onClick={save} disabled={locked || pending || !dirty}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <textarea
        aria-label="Integration definition (JSON)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={locked}
        spellCheck={false}
        className="min-h-[420px] w-full rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-accent read-only:opacity-70"
      />
      {locked && <p className="text-sm text-fg-muted">Deactivate the integration to edit it.</p>}
      {message && (
        <p role="status" className={`flex items-center gap-1.5 text-sm ${message.ok ? "text-success" : "text-danger"}`}>
          {message.ok ? (
            <CheckCircle2 className="size-4" aria-hidden />
          ) : (
            <AlertTriangle className="size-4" aria-hidden />
          )}
          {message.text}
        </p>
      )}
      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="flex flex-col gap-1.5 text-sm" aria-label="Problems">
          {errors.map((e, i) => (
            <li key={`e${i}`} className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
              <span className="font-mono text-xs text-danger">{pathText(e.path) || "document"}</span>
              <span className="mx-2 text-fg-muted">·</span>
              {e.message}
            </li>
          ))}
          {warnings.map((w, i) => (
            <li key={`w${i}`} className="rounded-lg border border-border bg-muted px-3 py-2">
              <span className="font-mono text-xs text-fg-muted">{pathText(w.path)}</span>
              <span className="mx-2 text-fg-muted">·</span>
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
