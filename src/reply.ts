import type { Message, SessionEvent } from "@deepseek-ai/dsh-session";

/** The minimal session surface reply extraction needs (satisfied by real Session). */
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
 * tool-call-only step, so scan backwards).
 */
export function extractTurnReply(session: ReplySession, turn: number): string | null {
  const events = session.snapshotEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "assistant/message") continue;
    if (event.turn !== turn) continue;
    const message = session.deriveEventMessage(event);
    if (message === null || message.role !== "assistant") continue;
    const text = messageText(message);
    if (text.trim() !== "") return text;
  }
  return null;
}

/** Truncate a reply for WeChat with an explicit marker. */
export function truncateForWeChat(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n（已截断，完整内容见 DSH 会话）`;
}
