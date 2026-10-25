"use client";

import { CheckCircle2, CircleDashed, Loader2, Send, Sparkles, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ChatItem, TOOL_LABELS } from "@/lib/transcript";
import { ProposalCard, type ProposalView } from "./proposal-card";

type LiveEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; name: string; status: "start" | "done" | "error"; detail?: string }
  | { type: "question"; question: string; choices: string[] }
  | { type: "proposal"; changeId: string; summary: string }
  | { type: "connection"; id: string; identifier: string; name: string }
  | { type: "error"; message: string }
  | { type: "done"; status: string };

function ToolChip({ name, ok }: { name: string; ok: boolean | null }) {
  const l = TOOL_LABELS[name] ?? { doing: name, done: name, failed: name };
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      {ok === null ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : ok ? (
        <CheckCircle2 className="size-3.5 text-success" aria-hidden />
      ) : (
        <XCircle className="size-3.5 text-danger" aria-hidden />
      )}
      {ok === null ? l.doing : ok ? l.done : l.failed}
    </div>
  );
}

export function Chat({
  sessionId,
  initialItems,
  proposals,
  status,
  lastError,
  initialSend,
  canBuild,
  placeholder,
}: {
  sessionId: string;
  initialItems: ChatItem[];
  proposals: Record<string, ProposalView>;
  status: string;
  lastError: string | null;
  initialSend: string | null;
  canBuild: boolean;
  placeholder: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [live, setLive] = useState<{
    text: string;
    thinking: boolean;
    tools: { name: string; ok: boolean | null }[];
    proposals: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(status === "error" ? lastError : null);
  const [draft, setDraft] = useState("");
  const sentInitial = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);
  // Block body on purpose: scrollIntoView returns a Promise in newer browsers,
  // and an effect must return nothing or a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items, live]);

  const pendingQuestion = (() => {
    const last = [...items].reverse().find((i) => i.kind === "question");
    return status === "waiting" && last?.kind === "question" && last.answer === null ? last : null;
  })();

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return;
      setBusy(true);
      setError(null);
      setItems((prev) => [...prev, { kind: "user", text }]);
      setLive({ text: "", thinking: false, tools: [], proposals: [] });
      try {
        const res = await fetch(`/api/ai/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? "The AI builder is unavailable.");
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6)) as LiveEvent;
            setLive((cur) => {
              if (!cur) return cur;
              switch (ev.type) {
                case "text":
                  return { ...cur, text: cur.text + ev.delta, thinking: false };
                case "thinking":
                  return { ...cur, thinking: true };
                case "tool":
                  if (ev.status === "start") return { ...cur, tools: [...cur.tools, { name: ev.name, ok: null }] };
                  return {
                    ...cur,
                    tools: cur.tools.map((t, i) =>
                      i === cur.tools.length - 1 && t.name === ev.name ? { ...t, ok: ev.status === "done" } : t,
                    ),
                  };
                case "proposal":
                  return { ...cur, proposals: [...cur.proposals, ev.summary] };
                default:
                  return cur;
              }
            });
            if (ev.type === "error") setError(ev.message);
          }
        }
      } catch {
        setError("Lost the connection to the AI builder. Reload to see where it got to.");
      } finally {
        setBusy(false);
        router.refresh();
        setLive(null);
      }
    },
    [busy, router, sessionId],
  );

  useEffect(() => {
    if (initialSend && !sentInitial.current && initialItems.length === 0) {
      sentInitial.current = true;
      router.replace(`/ai/${sessionId}`);
      void send(initialSend);
    }
  }, [initialSend, initialItems.length, router, send, sessionId]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft("");
    void send(text);
  };

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3" aria-label="Conversation">
        {items.map((item, i) => {
          const key = `${item.kind}-${i}`;
          switch (item.kind) {
            case "user":
              return (
                <li
                  key={key}
                  className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-sm text-accent-fg"
                >
                  {item.text}
                </li>
              );
            case "assistant":
              return (
                <li
                  key={key}
                  className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-border bg-panel px-4 py-2 text-sm"
                >
                  {item.text}
                </li>
              );
            case "tool":
              return (
                <li key={key} className="pl-2">
                  <ToolChip name={item.name} ok={item.ok} />
                </li>
              );
            case "question":
              return (
                <li
                  key={key}
                  className="max-w-[85%] rounded-2xl rounded-bl-sm border border-accent/40 bg-accent/5 px-4 py-3 text-sm"
                >
                  <div className="font-medium">{item.question}</div>
                  {item.answer === null && pendingQuestion?.id === item.id && item.choices.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.choices.map((c) => (
                        <Button
                          key={c}
                          size="sm"
                          variant="secondary"
                          disabled={busy || !canBuild}
                          onClick={() => void send(c)}
                        >
                          {c}
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              );
            case "proposal": {
              const p = proposals[item.changeId];
              return p ? (
                <li key={key}>
                  <ProposalCard p={p} canBuild={canBuild} />
                </li>
              ) : null;
            }
            default:
              return null;
          }
        })}
        {live && (
          <li className="flex flex-col gap-2" aria-live="polite">
            {live.tools.map((t, i) => (
              <div key={`${t.name}-${i}`} className="pl-2">
                <ToolChip name={t.name} ok={t.ok} />
              </div>
            ))}
            {live.proposals.map((s) => (
              <div
                key={s}
                className="flex items-center gap-2 rounded-xl border-2 border-accent/30 bg-panel p-3 text-sm"
              >
                <Sparkles className="size-4 text-accent" aria-hidden /> Proposal ready: {s}
              </div>
            ))}
            {live.text ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-border bg-panel px-4 py-2 text-sm">
                {live.text}
              </div>
            ) : (
              <div className="flex items-center gap-2 pl-2 text-xs text-fg-muted">
                <CircleDashed className="size-3.5 animate-spin" aria-hidden />
                {live.thinking ? "Thinking…" : "Working…"}
              </div>
            )}
          </li>
        )}
      </ol>
      <div ref={bottom} />

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {canBuild && (
        <form
          onSubmit={onSubmit}
          className="sticky bottom-4 flex items-end gap-2 rounded-2xl border border-border bg-panel p-2 shadow-sm"
        >
          <textarea
            aria-label="Message the AI builder"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            placeholder={pendingQuestion ? "Type your answer…" : placeholder}
            rows={2}
            className="min-h-11 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm focus:outline-none"
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !draft.trim()} aria-label="Send">
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          </Button>
        </form>
      )}
    </div>
  );
}
