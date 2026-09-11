import { describe, expect, it } from "vitest";
import {
  autoAnswer,
  formatQuestionForWeChat,
  parseWeChatAnswer,
} from "../src/ask.js";
import type {
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";

function question(overrides: Partial<AskUserQuestionItem> & { id: string }): AskUserQuestionItem {
  return {
    question: "怎么做？",
    options: [
      { label: "方案甲" },
      { label: "方案乙", description: "更稳妥" },
    ],
    ...overrides,
  };
}

function request(...questions: AskUserQuestionItem[]): AskUserQuestionRequest {
  return { questions };
}

describe("formatQuestionForWeChat", () => {
  it("formats a single question with numbered options and a hint", () => {
    const text = formatQuestionForWeChat(request(question({ id: "q1", question: "用哪种方式？" })));
    expect(text).toContain("用哪种方式？");
    expect(text).toContain("1. 方案甲");
    expect(text).toContain("2. 方案乙 — 更稳妥");
    expect(text).toContain("回复数字或选项文字");
  });

  it("includes truncated detail when present", () => {
    const text = formatQuestionForWeChat(request(
      question({ id: "q1", question: "批准这个计划吗？", detail: "# 计划\n第一步…".repeat(50) }),
    ));
    expect(text).toContain("批准这个计划吗？");
    expect(text.length).toBeLessThan(1200);
  });

  it("numbers multiple questions and asks for semicolon-separated answers", () => {
    const text = formatQuestionForWeChat(request(
      question({ id: "q1", question: "第一个问题？" }),
      question({ id: "q2", question: "第二个问题？" }),
    ));
    expect(text).toContain("1/2");
    expect(text).toContain("第一个问题？");
    expect(text).toContain("2/2");
    expect(text).toContain("第二个问题？");
    expect(text).toContain("分号");
  });

  it("marks multi-select questions", () => {
    const text = formatQuestionForWeChat(request(
      question({ id: "q1", question: "选哪些？", multiSelect: true }),
    ));
    expect(text).toContain("多选");
  });

  it("handles a question without options (free text)", () => {
    const text = formatQuestionForWeChat(request(
      question({ id: "q1", question: "叫什么名字？", options: undefined }),
    ));
    expect(text).toContain("叫什么名字？");
    expect(text).not.toContain("1.");
  });
});

describe("parseWeChatAnswer", () => {
  it("selects by option number", () => {
    const answer = parseWeChatAnswer("1", [question({ id: "q1" })]);
    expect(answer.answers[0]).toEqual({ id: "q1", selected: ["方案甲"], custom: undefined });
  });

  it("selects by option label text", () => {
    const answer = parseWeChatAnswer("方案乙", [question({ id: "q1" })]);
    expect(answer.answers[0].selected).toEqual(["方案乙"]);
  });

  it("matches labels case-insensitively and by containment", () => {
    const item = question({ id: "q1", options: [{ label: "Deploy to Production" }] });
    expect(parseWeChatAnswer("deploy to production", [item]).answers[0].selected).toEqual(["Deploy to Production"]);
    expect(parseWeChatAnswer("production", [item]).answers[0].selected).toEqual(["Deploy to Production"]);
  });

  it("falls back to a custom answer for unmatched text", () => {
    const answer = parseWeChatAnswer("都不行，换个思路", [question({ id: "q1" })]);
    expect(answer.answers[0]).toEqual({ id: "q1", selected: [], custom: "都不行，换个思路" });
  });

  it("answers option-less questions with custom text", () => {
    const answer = parseWeChatAnswer("张三", [question({ id: "q1", options: undefined })]);
    expect(answer.answers[0].custom).toBe("张三");
  });

  it("parses multi-select comma-separated numbers and labels", () => {
    const item = question({ id: "q1", multiSelect: true });
    const byNumbers = parseWeChatAnswer("1, 2", [item]);
    expect(byNumbers.answers[0].selected).toEqual(["方案甲", "方案乙"]);
    const byLabels = parseWeChatAnswer("方案甲、方案乙", [item]);
    expect(byLabels.answers[0].selected).toEqual(["方案甲", "方案乙"]);
  });

  it("splits multiple questions by semicolons", () => {
    const answer = parseWeChatAnswer("1；方案乙", [
      question({ id: "q1", question: "一？" }),
      question({ id: "q2", question: "二？" }),
    ]);
    expect(answer.answers[0].selected).toEqual(["方案甲"]);
    expect(answer.answers[1].selected).toEqual(["方案乙"]);
  });

  it("fills unanswered questions with the skipped shape", () => {
    const answer = parseWeChatAnswer("1", [
      question({ id: "q1", question: "一？" }),
      question({ id: "q2", question: "二？" }),
    ]);
    expect(answer.answers[0].selected).toEqual(["方案甲"]);
    expect(answer.answers[1]).toEqual({ id: "q2", selected: [] });
  });

  it("treats an out-of-range number as custom text", () => {
    const answer = parseWeChatAnswer("5", [question({ id: "q1" })]);
    expect(answer.answers[0].custom).toBe("5");
    expect(answer.answers[0].selected).toEqual([]);
  });
});

describe("autoAnswer", () => {
  it("answers every question with the decide-yourself custom text", () => {
    const answer = autoAnswer([question({ id: "q1" }), question({ id: "q2", options: undefined })]);
    expect(answer.answers).toHaveLength(2);
    for (const item of answer.answers) {
      expect(item.selected).toEqual([]);
      expect(item.custom).toContain("由你自行决定");
    }
    expect(answer.answers.map((a) => a.id)).toEqual(["q1", "q2"]);
  });
});
