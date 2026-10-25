// Turns the stored model conversation (content blocks) into chat items for S28.

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; ok: boolean | null }
  | { kind: "question"; id: string; question: string; choices: string[]; answer: string | null }
  | { kind: "proposal"; changeId: string };

export const TOOL_LABELS: Record<string, { doing: string; done: string; failed: string }> = {
  list_connections: {
    doing: "Checking your connections",
    done: "Checked your connections",
    failed: "Could not read connections",
  },
  list_adapters: { doing: "Looking up adapters", done: "Looked up adapters", failed: "Could not read adapters" },
  get_flow: {
    doing: "Reading the integration",
    done: "Read the integration",
    failed: "Could not read the integration",
  },
  infer_schema: { doing: "Reading your sample", done: "Read your sample", failed: "The sample is not valid JSON" },
  test_expression: {
    doing: "Testing a mapping",
    done: "Tested a mapping",
    failed: "A mapping did not work; adjusting",
  },
  request_connection: {
    doing: "Drafting a connection",
    done: "Drafted a connection",
    failed: "Could not draft the connection",
  },
  propose_flow: {
    doing: "Building the integration",
    done: "Proposed the integration",
    failed: "Found problems in the draft; fixing them",
  },
};

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: { question?: string; choices?: string[] };
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c as Block).text ?? "").join("");
  return "";
}

export function toChatItems(
  messages: { role: "user" | "assistant"; content: unknown[] }[],
  /** While a question is pending, the other results of that turn are held with it, not yet in messages. */
  pendingResults: unknown[] = [],
): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ChatItem & { kind: "tool" }>();
  const questions = new Map<string, ChatItem & { kind: "question" }>();

  for (const m of messages) {
    for (const raw of m.content) {
      const b = raw as Block;
      if (m.role === "user") {
        if (b.type === "text" && b.text && !b.text.startsWith("<context>")) items.push({ kind: "user", text: b.text });
        if (b.type === "tool_result" && b.tool_use_id) {
          const q = questions.get(b.tool_use_id);
          if (q) {
            q.answer = resultText(b.content);
            items.push({ kind: "user", text: q.answer });
            continue;
          }
          const t = tools.get(b.tool_use_id);
          if (t) t.ok = !b.is_error;
          if (t?.name === "propose_flow" && !b.is_error) {
            try {
              const parsed = JSON.parse(resultText(b.content)) as { proposalId?: string };
              if (parsed.proposalId) items.push({ kind: "proposal", changeId: parsed.proposalId });
            } catch {
              // not a proposal result
            }
          }
        }
      } else {
        if (b.type === "text" && b.text?.trim()) {
          const last = items[items.length - 1];
          if (last?.kind === "assistant") last.text += `\n\n${b.text}`;
          else items.push({ kind: "assistant", text: b.text });
        }
        if (b.type === "tool_use" && b.id && b.name) {
          if (b.name === "ask_user") {
            const q = {
              kind: "question" as const,
              id: b.id,
              question: b.input?.question ?? "",
              choices: b.input?.choices ?? [],
              answer: null,
            };
            questions.set(b.id, q);
            items.push(q);
          } else {
            const t = { kind: "tool" as const, id: b.id, name: b.name, ok: null };
            tools.set(b.id, t);
            items.push(t);
          }
        }
      }
    }
  }
  for (const raw of pendingResults) {
    const b = raw as Block;
    const t = b.tool_use_id ? tools.get(b.tool_use_id) : undefined;
    if (t) t.ok = !b.is_error;
  }
  return items;
}
