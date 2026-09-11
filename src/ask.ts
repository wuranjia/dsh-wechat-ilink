import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";

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
      ? `${item.detail.slice(0, MAX_DETAIL_CHARS)}…（已截断）`
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
  return parts.join("\n");
}

/** Match one reply part against one question's options. */
function answerOne(item: AskUserQuestionItem, reply: string): AskUserQuestionAnswerItem {
  const text = reply.trim();
  if (text === "") return { id: item.id, selected: [] };
  if (item.options === undefined || item.options.length === 0) {
    return { id: item.id, selected: [], custom: text };
  }
  const labels = item.options.map((option) => option.label);
  const matchLabel = (part: string): string | undefined => {
    const trimmed = part.trim();
    if (trimmed === "") return undefined;
    const exact = labels.find((label) => label === trimmed);
    if (exact !== undefined) return exact;
    const lower = trimmed.toLowerCase();
    const insensitive = labels.find((label) => label.toLowerCase() === lower);
    if (insensitive !== undefined) return insensitive;
    return labels.find((label) => label.toLowerCase().includes(lower));
  };
  const matchPart = (part: string): string | undefined => {
    const numeric = Number(part.trim());
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= labels.length) {
      return labels[numeric - 1];
    }
    return matchLabel(part);
  };
  if (item.multiSelect === true) {
    const selected: string[] = [];
    for (const part of text.split(/[,，、]/)) {
      const label = matchPart(part);
      if (label !== undefined && !selected.includes(label)) selected.push(label);
    }
    if (selected.length > 0) return { id: item.id, selected, custom: undefined };
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
  const parts = reply.split(/[;；]/);
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
