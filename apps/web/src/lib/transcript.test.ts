import { describe, expect, it } from "vitest";
import { toChatItems } from "./transcript";

describe("toChatItems", () => {
  const ask = { type: "tool_use", id: "q1", name: "ask_user", input: { question: "How often?", choices: ["Hourly"] } };
  const list = { type: "tool_use", id: "t1", name: "list_connections", input: {} };

  it("hides the context preamble and shows the person's words", () => {
    const items = toChatItems([
      {
        role: "user",
        content: [
          { type: "text", text: "<context>\nProject: X\n</context>" },
          { type: "text", text: "sync orders" },
        ],
      },
    ]);
    expect(items).toEqual([{ kind: "user", text: "sync orders" }]);
  });

  it("marks tools done from results held with a pending question", () => {
    const messages = [
      { role: "user" as const, content: [{ type: "text", text: "go" }] },
      { role: "assistant" as const, content: [{ type: "text", text: "Checking." }, list, ask] },
    ];
    const waiting = toChatItems(messages, [{ type: "tool_result", tool_use_id: "t1", content: "[]" }]);
    expect(waiting.find((i) => i.kind === "tool")).toMatchObject({ ok: true });
    expect(waiting.find((i) => i.kind === "question")).toMatchObject({ answer: null });
  });

  it("shows answers and places proposals where they were made", () => {
    const items = toChatItems([
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [list, ask] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "[]" },
          { type: "tool_result", tool_use_id: "q1", content: "Hourly" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "p1", name: "propose_flow", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "p1", content: JSON.stringify({ proposalId: "c-1" }) }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Done." },
        ],
      },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "question", "user", "tool", "proposal", "assistant"]);
    expect(items[3]).toEqual({ kind: "user", text: "Hourly" });
    expect(items[5]).toEqual({ kind: "proposal", changeId: "c-1" });
  });

  it("does not show failed proposals as cards", () => {
    const items = toChatItems([
      { role: "assistant", content: [{ type: "tool_use", id: "p1", name: "propose_flow", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "p1", is_error: true, content: "problems" }] },
    ]);
    expect(items).toEqual([{ kind: "tool", id: "p1", name: "propose_flow", ok: false }]);
  });
});
