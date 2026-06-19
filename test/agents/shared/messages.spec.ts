import { describe, it, expect } from "vitest";
import type { SessionMessage } from "agents/experimental/memory/session";
import {
  userSessionMessage,
  assistantSessionMessage,
  sessionText,
  toModelMessages
} from "@/agents/shared/messages";

describe("userSessionMessage", () => {
  it("produces a user-role message with the given text", () => {
    const m = userSessionMessage("hello");
    expect(m.role).toBe("user");
    expect(m.parts).toHaveLength(1);
    expect(m.parts[0]).toMatchObject({ type: "text", text: "hello" });
  });

  it("assigns a non-empty string id", () => {
    const m = userSessionMessage("hi");
    expect(typeof m.id).toBe("string");
    expect(m.id.length).toBeGreaterThan(0);
  });

  it("generates a unique id on each call", () => {
    const a = userSessionMessage("x");
    const b = userSessionMessage("x");
    expect(a.id).not.toBe(b.id);
  });
});

describe("assistantSessionMessage", () => {
  it("produces an assistant-role message with the given text", () => {
    const m = assistantSessionMessage("reply");
    expect(m.role).toBe("assistant");
    expect(m.parts[0]).toMatchObject({ type: "text", text: "reply" });
  });

  it("generates a unique id each call", () => {
    const a = assistantSessionMessage("x");
    const b = assistantSessionMessage("x");
    expect(a.id).not.toBe(b.id);
  });
});

describe("sessionText", () => {
  it("returns the text of a single-part message", () => {
    const m = userSessionMessage("hello world");
    expect(sessionText(m)).toBe("hello world");
  });

  it("concatenates multiple text parts in order", () => {
    const m: SessionMessage = {
      id: "1",
      role: "user",
      parts: [
        { type: "text", text: "foo" },
        { type: "text", text: "bar" }
      ]
    };
    expect(sessionText(m)).toBe("foobar");
  });

  it("ignores non-text parts (e.g. tool-call)", () => {
    const m = {
      id: "2",
      role: "assistant",
      parts: [
        { type: "tool-call", toolCallId: "x", toolName: "recall", input: {} },
        { type: "text", text: "result" }
      ]
    } as unknown as SessionMessage;
    expect(sessionText(m)).toBe("result");
  });

  it("ignores parts where text is not a string", () => {
    const m = {
      id: "3",
      role: "user",
      parts: [
        { type: "text", text: 42 },
        { type: "text", text: "valid" }
      ]
    } as unknown as SessionMessage;
    expect(sessionText(m)).toBe("valid");
  });

  it("returns empty string when there are no text parts", () => {
    const m = {
      id: "4",
      role: "user",
      parts: [{ type: "tool-call", toolCallId: "x", toolName: "y", input: {} }]
    } as unknown as SessionMessage;
    expect(sessionText(m)).toBe("");
  });
});

describe("toModelMessages", () => {
  it("maps history to role/content pairs", () => {
    const history: SessionMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "2",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }]
      }
    ];
    expect(toModelMessages(history)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]);
  });

  it("filters out non-user/assistant roles", () => {
    const history = [
      { id: "s", role: "system", parts: [{ type: "text", text: "ignore" }] },
      { id: "u", role: "user", parts: [{ type: "text", text: "keep" }] }
    ] as unknown as SessionMessage[];
    const out = toModelMessages(history);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("uses sessionText to join multi-part content", () => {
    const history: SessionMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [
          { type: "text", text: "part1" },
          { type: "text", text: "part2" }
        ]
      }
    ];
    expect(toModelMessages(history)[0].content).toBe("part1part2");
  });

  it("returns an empty array for empty history", () => {
    expect(toModelMessages([])).toEqual([]);
  });
});
