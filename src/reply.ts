import type { Message } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * The minimal session surface reply extraction needs (satisfied by real Session).
 * Method syntax is load-bearing: parameter bivariance makes the real Session's
 * branded params compatible; property-syntax arrow functions would break
 * assignability from the real Session.
 */
export interface ReplySession {
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[];
  deriveEventMessage(event: SessionEvent): Message | null;
}

/** Concatenate the text blocks of one message. */
export function messageText(message: Message): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/**
 * Extract the reply text for one finished turn: the last non-empty
 * assistant text in that turn's log (multi-step turns may end on a
 * tool-call-only step, so scan backwards). Interrupted messages — a turn
 * cancelled mid-stream finalizes its partial text with `interrupted: true` —
 * are skipped so earlier complete messages of the turn win.
 */
export function extractTurnReply(session: ReplySession, turn: number): string | null {
  const events = session.snapshotEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "assistant/message") continue;
    if (event.data.turn !== turn) continue;
    if (event.data.interrupted === true) continue;
    const message = session.deriveEventMessage(event);
    if (message === null || message.role !== "assistant") continue;
    const text = messageText(message);
    if (text.trim() !== "") return text;
  }
  return null;
}

/**
 * Truncate a reply for WeChat with an explicit marker.
 *
 * `maxChars` counts UTF-16 code units and is a soft limit: the result keeps
 * at most `maxChars` units of `text` and may exceed that by the fixed marker.
 * A surrogate pair straddling the cut is kept whole by backing off one unit.
 */
export function truncateForWeChat(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n\n（已截断，完整内容见 DSH 会话）`;
}
