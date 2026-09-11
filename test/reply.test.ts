import { describe, expect, it } from "vitest";
import { extractTurnReply, messageText, truncateForWeChat } from "../src/reply.js";
import { MessageId, ToolCallId, type Message } from "@deepseek-ai/dsh-llm";
import { assistantEvent, fakeSession } from "./helpers.js";

describe("messageText", () => {
  it("joins text blocks and ignores other blocks", () => {
    const message: Message = {
      id: MessageId("m"),
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "tool-call", id: ToolCallId("c"), name: "t", arguments: "{}" },
        { type: "text", text: "world" },
      ],
      source: { kind: "model", provider: "p", model: "m" },
    };
    expect(messageText(message)).toBe("hello world");
  });
});

describe("extractTurnReply", () => {
  it("returns the last non-empty assistant text of the turn", () => {
    const session = fakeSession([
      assistantEvent(1, 1, "turn one reply"),
      assistantEvent(2, 2, "first step text"),
      assistantEvent(3, 2, "final answer"),
    ]);
    expect(extractTurnReply(session, 2)).toBe("final answer");
  });

  it("skips assistant messages belonging to other turns", () => {
    const session = fakeSession([
      assistantEvent(1, 1, "turn one"),
      assistantEvent(2, 2, ""),
    ]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });

  it("falls back to an earlier non-empty text when the last is empty", () => {
    const session = fakeSession([
      assistantEvent(1, 2, "earlier text"),
      assistantEvent(2, 2, ""),
    ]);
    expect(extractTurnReply(session, 2)).toBe("earlier text");
  });

  it("returns null when the turn has no assistant text at all", () => {
    const session = fakeSession([assistantEvent(1, 2, "")]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });

  it("skips interrupted messages and falls back to the last complete one", () => {
    const session = fakeSession([
      assistantEvent(1, 2, "complete text"),
      assistantEvent(2, 2, "partial frag", true),
    ]);
    expect(extractTurnReply(session, 2)).toBe("complete text");
  });

  it("returns null when every assistant message in the turn was interrupted", () => {
    const session = fakeSession([assistantEvent(1, 2, "frag", true)]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });

  it("returns null for an empty event log", () => {
    expect(extractTurnReply(fakeSession([]), 1)).toBeNull();
  });

  it("treats whitespace-only text as empty", () => {
    const session = fakeSession([assistantEvent(1, 2, "   ")]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });
});

describe("truncateForWeChat", () => {
  it("keeps short text unchanged", () => {
    expect(truncateForWeChat("短回复", 100)).toBe("短回复");
  });

  it("returns text unchanged at the exact boundary", () => {
    const text = "x".repeat(100);
    expect(truncateForWeChat(text, 100)).toBe(text);
  });

  it("truncates long text with a marker", () => {
    const text = "x".repeat(250);
    const result = truncateForWeChat(text, 100);
    expect(result.length).toBeLessThanOrEqual(100 + 30);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result).toContain("已截断");
  });

  it("does not split a surrogate pair when truncating", () => {
    const result = truncateForWeChat("a".repeat(99) + "😀", 100);
    // Cutting at 100 units would orphan 😀's high surrogate; back off to 99.
    expect(result.startsWith("a".repeat(99) + "\n\n")).toBe(true);
    expect(result).toContain("已截断");
  });
});
