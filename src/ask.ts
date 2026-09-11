import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";

import { sliceCodeUnits } from "./reply.js";

/** Bound for `detail` text (plans can be long); the question itself is never truncated. */
const MAX_DETAIL_CHARS = 600;

const SINGLE_HINT = "（回复数字或选项文字；也可以直接回复其他内容作为自由回答）";
const MULTI_HINT = "（可多选，用逗号分隔；也可以直接回复其他内容）";
const BATCH_HINT = "（多个问题请用分号「；」依次回答）";

const AUTO_REPLY_TEXT = "由你自行决定，请选择你认为最合适的方案";

/** One selectable option rendered for WeChat. */
function optionLine(index: number, label: string, description?: string): string {
  return description === undefined ? `${index}. ${label}` : `${index}. ${label} — ${description}`;
}

/** Render one question block for WeChat. */
function questionBlock(item: AskUserQuestionItem): string {
  const lines: string[] = [];
  if (item.detail !== undefined && item.detail !== "") {
    const detail = item.detail.length > MAX_DETAIL_CHARS
      ? `${sliceCodeUnits(item.detail, MAX_DETAIL_CHARS)}…（已截断）`
      : item.detail;
    lines.push(detail, "");
  }
  lines.push(item.question);
  if (item.options !== undefined) {
    for (const [index, option] of item.options.entries()) {
      lines.push(optionLine(index + 1, option.label, option.description));
    }
    lines.push(item.multiSelect === true ? MULTI_HINT : SINGLE_HINT);
  }
  return lines.join("\n");
}

/** Format a user-questions request as WeChat text. */
export function formatQuestionForWeChat(request: AskUserQuestionRequest): string {
  const total = request.questions.length;
  const blocks = request.questions.map((item, index) =>
    total === 1 ? questionBlock(item) : `[${index + 1}/${total}] ${questionBlock(item)}`,
  );
  const parts = ["❓"];
  parts.push(...blocks);
  if (total > 1) parts.push(BATCH_HINT);
  return parts.join("\n\n");
}

/** Parse one question's reply text (a whole reply, or one batch part) into an answer. */
function answerOne(item: AskUserQuestionItem, reply: string): AskUserQuestionAnswerItem {
  const text = reply.trim();
  if (text === "") return { id: item.id, selected: [] };
  if (item.options === undefined || item.options.length === 0) {
    return { id: item.id, selected: [], custom: text };
  }
  const labels = item.options.map((option) => option.label);
  // Tier 1 — exact label: a reply equal to a label always means that label, even
  // when the label is itself a number ("3" selects the label "3", not index 3).
  const matchExactLabel = (part: string): string | undefined => {
    const trimmed = part.trim();
    if (trimmed === "") return undefined;
    return labels.find((label) => label === trimmed);
  };
  // Tier 2 — option number: digits only after stripping one trailing [.。、],
  // within 1..options.length. Strict on purpose — Number() would also accept
  // "1e0", "0x1", "+1", or "1.5" as numbers.
  const matchOptionNumber = (part: string): string | undefined => {
    const trimmed = part.trim().replace(/[.。、]$/, "");
    if (!/^\d+$/.test(trimmed)) return undefined;
    const numeric = Number(trimmed);
    if (numeric < 1 || numeric > labels.length) return undefined;
    return labels[numeric - 1];
  };
  // Tiers 3/4 — case-insensitive label equality, then containment.
  const matchLooseLabel = (part: string): string | undefined => {
    const trimmed = part.trim();
    if (trimmed === "") return undefined;
    const lower = trimmed.toLowerCase();
    const insensitive = labels.find((label) => label.toLowerCase() === lower);
    if (insensitive !== undefined) return insensitive;
    return labels.find((label) => label.toLowerCase().includes(lower));
  };
  const matchPart = (part: string): string | undefined =>
    matchExactLabel(part) ?? matchOptionNumber(part) ?? matchLooseLabel(part);
  if (item.multiSelect === true) {
    const selected: string[] = [];
    const unmatched: string[] = [];
    for (const part of text.split(/[,，、]/)) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const label = matchPart(part);
      if (label === undefined) unmatched.push(trimmed);
      else if (!selected.includes(label)) selected.push(label);
    }
    // Partial matches keep both halves: matched labels → selected, leftover
    // text → custom ("1, 随便" must not drop "随便"). Nothing matched → whole text.
    if (selected.length > 0) {
      const custom = unmatched.length > 0 ? unmatched.join("；") : undefined;
      return { id: item.id, selected, custom };
    }
    return { id: item.id, selected: [], custom: text };
  }
  const label = matchPart(text);
  if (label !== undefined) return { id: item.id, selected: [label], custom: undefined };
  return { id: item.id, selected: [], custom: text };
}

/** Parse a WeChat reply into a structured answer for the asked questions. */
export function parseWeChatAnswer(reply: string, questions: AskUserQuestionItem[]): AskUserQuestionAnswer {
  if (questions.length === 1) {
    return { answers: [answerOne(questions[0], reply)] };
  }
  const parts = reply.split(/[;；\n]/);
  const answers = questions.map((item, index) =>
    answerOne(item, parts[index] ?? ""),
  );
  return { answers };
}

/** The `auto` ask-mode answer: decide yourself, never wait. */
export function autoAnswer(questions: AskUserQuestionItem[]): AskUserQuestionAnswer {
  return {
    answers: questions.map((item) => ({
      id: item.id,
      selected: [],
      custom: AUTO_REPLY_TEXT,
    })),
  };
}
