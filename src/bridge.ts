import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { formatQuestionForWeChat, parseWeChatAnswer } from "./ask.js";
import { extractTurnReply, truncateForWeChat, type ReplySession } from "./reply.js";
import type { BridgeStore } from "./store.js";

/** How the bridge sends WeChat messages (implemented over the iLink SDK). */
export interface BridgeSender {
  send(userId: string, text: string): Promise<void>;
  sendTyping(userId: string): Promise<void>;
}

/** Resolved plugin configuration (defaults applied, paths absolute). */
export interface BridgeConfig {
  allowUsers: ReadonlySet<string>;
  workspaceRoot: string;
  agentPreset: string;
  permissionPreset: string;
  sessionIdleTimeoutMs: number;
  maxReplyChars: number;
  model: { provider: string; model: string } | undefined;
}

/** The session surface onSessionEvent needs (satisfied by the real Session). */
export type EventSession = ReplySession & { header: { id: string } };

/**
 * The DSH services the bridge uses (satisfied by the real plugin Context).
 * Method syntax is load-bearing: it carries parameter bivariance, which the
 * real Context's branded parameters rely on — do not convert to arrow-function properties.
 */
export interface BridgeContext {
  agents: {
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  };
  agentPresets: {
    resolve(id: string): Promise<{ id: string }>;
    standingKeyFor(id: string): Promise<unknown>;
    // Promise<unknown>, not Promise<void>: the real AgentPresets.mount resolves
    // to the mounted preset; the bridge awaits it and discards the value.
    mount(agentCtx: Context, id: string): Promise<unknown>;
  };
  permissionPresets: { set(session: unknown, name: string): void };
  workspaceRegistry: {
    create(path: string): Promise<{ path: string; attachSession(sessionId: string): Promise<void> }>;
  };
  sessionTitle: { rename(session: unknown, title: string): void };
  agentDefaultModel: { currentSelection(): { provider: string; model: string } };
  logger: { debug(message: string): void; info(message: string): void; warn(message: string): void };
}

interface LiveEntry {
  handle: AgentHandle;
  sessionId: string;
  lastActiveMs: number;
}

interface PendingQuestion {
  questions: AskUserQuestionRequest["questions"];
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (error: unknown) => void;
  detachSignal: () => void;
}

const UNSUPPORTED_TYPE_REPLY = "（v1 仅支持文本消息）";
const NO_TEXT_REPLY = "（任务已完成，无文本回复）";
const FAILED_NO_TEXT_REPLY = "（本回合处理失败，未产生回复；可重发消息重试）";

/** One WeChat user ↔ one live DSH agent, with durable session continuity. */
export class WeChatBridge {
  private readonly live = new Map<string, LiveEntry>();
  private readonly sessionOwners = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<LiveEntry>>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private disposed = false;

  constructor(
    private readonly ctx: BridgeContext,
    private readonly config: BridgeConfig,
    private readonly store: BridgeStore,
    private readonly sender: BridgeSender,
  ) {}

  /** Entry point for one incoming WeChat message. */
  async handleMessage(userId: string, type: string, text: string): Promise<void> {
    if (this.disposed) return;
    if (!this.config.allowUsers.has(userId)) {
      // info (not debug): this line is the documented way to discover your WeChat
      // user id for the allowlist, and an unknown contact messaging the bot is a
      // security-relevant signal worth surfacing at the default log level.
      this.ctx.logger.info(`wechat-ilink: ignored message from non-allowlisted user ${JSON.stringify(userId)} (add it to allowUsers to accept)`);
      return;
    }
    const pending = this.pendingQuestions.get(userId);
    if (pending !== undefined) {
      if (type !== "text" || text.trim() === "") {
        await this.sender.send(userId, UNSUPPORTED_TYPE_REPLY);
        return;
      }
      // answering counts as activity: refresh the clock so the idle sweep
      // does not dispose the session out from under a still-engaged user
      const entry = this.live.get(userId);
      if (entry !== undefined) {
        entry.lastActiveMs = Date.now();
        await this.store.set(userId, { sessionId: entry.sessionId, lastActiveMs: entry.lastActiveMs });
      }
      pending.resolve(parseWeChatAnswer(text, pending.questions));
      return;
    }
    if (type !== "text" || text.trim() === "") {
      await this.sender.send(userId, UNSUPPORTED_TYPE_REPLY);
      return;
    }
    try {
      const entry = await this.ensureAgent(userId);
      entry.lastActiveMs = Date.now();
      await this.store.set(userId, { sessionId: entry.sessionId, lastActiveMs: entry.lastActiveMs });
      await this.sender.sendTyping(userId).catch(() => {});
      entry.handle.agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "plugin",
          plugin: "wechat-ilink",
          form: "notice",
          summary: boundContextSummary(`WeChat message from ${userId}`),
        },
      }));
    } catch (error) {
      this.ctx.logger.warn(`wechat-ilink: handling message from ${JSON.stringify(userId)} failed: ${String(error)}`);
      await this.sender.send(userId, `（处理失败：${String(error)}）`).catch(() => {});
    }
  }

  /** `session/event` firehose entry; routes finished turns back to WeChat. */
  onSessionEvent(session: EventSession, event: SessionEvent): void {
    if (event.type !== "turn/end") return;
    const userId = this.sessionOwners.get(session.header.id);
    if (userId === undefined) return;
    const { turn, reason } = event.data;
    if (reason.kind === "aborted" || reason.kind === "interrupted") return;
    const text = extractTurnReply(session, turn);
    const failed = reason.kind === "error" || reason.kind === "blocked";
    if (text === null) {
      const notice = failed ? FAILED_NO_TEXT_REPLY : NO_TEXT_REPLY;
      void this.sender.send(userId, notice)
        .catch((error) => this.replyFailed(userId, error));
      return;
    }
    const body = reason.kind === "error" ? `${text}\n\n（本回合以错误结束）` : text;
    void this.sender.send(userId, truncateForWeChat(body, this.config.maxReplyChars))
      .catch((error) => this.replyFailed(userId, error));
  }

  /**
   * Claim a user-questions request for a WeChat-owned agent: send the
   * question to WeChat and wait for the user's reply. Returns undefined when
   * the request does not belong to a WeChat session (the caller should
   * delegate to the next answerer).
   */
  tryClaimQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> | undefined {
    if (this.disposed) return undefined;
    if (request.agent === undefined) return undefined;
    const userId = this.sessionOwners.get(request.agent.session.header.id);
    if (userId === undefined) return undefined;
    return this.claimUserQuestion(userId, request);
  }

  private claimUserQuestion(userId: string, request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    this.supersedePending(userId);
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      let pending: PendingQuestion;
      // identity-checked: only settle our own map entry, never a successor's
      const settle = () => {
        if (this.pendingQuestions.get(userId) !== pending) return;
        this.pendingQuestions.delete(userId);
        pending.detachSignal();
      };
      const onAbort = () => {
        settle();
        reject(new Error("ask aborted"));
        // bot may already be stopped during teardown — the notice is best-effort
        void this.sender.send(userId, "（问题已取消）").catch(() => {});
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      pending = {
        questions: request.questions,
        resolve: (answer) => {
          settle();
          resolve(answer);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        detachSignal: () => {
          request.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pendingQuestions.set(userId, pending);
      try {
        this.sender.send(userId, formatQuestionForWeChat(request)).catch((error) => {
          if (this.pendingQuestions.get(userId) !== pending) return; // superseded while in flight
          pending.reject(error);
        });
      } catch (error) {
        // sender.send threw synchronously — reject this claim, not a successor's
        pending.reject(error);
      }
    });
  }

  /** Reject a still-pending question for this user (a new one supersedes it). */
  private supersedePending(userId: string): void {
    const pending = this.pendingQuestions.get(userId);
    if (pending === undefined) return;
    this.pendingQuestions.delete(userId);
    pending.detachSignal();
    pending.reject(new Error("superseded by a new question"));
  }

  /** Dispose agents idle beyond the timeout; the next message starts a new session. */
  async sweepIdle(now = Date.now()): Promise<void> {
    for (const [userId, entry] of [...this.live]) {
      if (now - entry.lastActiveMs < this.config.sessionIdleTimeoutMs) continue;
      // A turn outlasting the idle timeout must not be disposed mid-flight;
      // the next sweep after it goes idle will collect it.
      if (entry.handle.agent.status === "running") continue;
      this.forget(userId, entry);
      try {
        await this.store.delete(userId);
      } catch (error) {
        this.ctx.logger.warn(`wechat-ilink: deleting stored session for ${JSON.stringify(userId)} failed: ${String(error)}`);
      }
      try {
        await entry.handle.dispose();
      } catch (error) {
        this.ctx.logger.warn(`wechat-ilink: disposing idle agent for ${JSON.stringify(userId)} failed: ${String(error)}`);
      }
    }
  }

  /** Stop everything (plugin unload); drains in-flight creates first. Store entries are kept so sessions resume on the next start. */
  async dispose(): Promise<void> {
    for (const [userId, pending] of [...this.pendingQuestions]) {
      this.pendingQuestions.delete(userId);
      pending.detachSignal();
      pending.reject(new Error("bridge disposed"));
    }
    this.disposed = true;
    await Promise.allSettled([...this.inflight.values()]);
    for (const [userId, entry] of [...this.live]) {
      this.forget(userId, entry);
      try {
        await entry.handle.dispose();
      } catch {
        // best effort during teardown
      }
    }
  }

  private forget(userId: string, entry: LiveEntry): void {
    this.live.delete(userId);
    this.sessionOwners.delete(entry.sessionId);
    // defensive: the ask signal aborts on agent disposal; clear any pending question too
    const pending = this.pendingQuestions.get(userId);
    if (pending !== undefined) {
      this.pendingQuestions.delete(userId);
      pending.detachSignal();
      pending.reject(new Error("session swept"));
    }
  }

  private replyFailed(userId: string, error: unknown): void {
    this.ctx.logger.warn(`wechat-ilink: reply to ${JSON.stringify(userId)} failed: ${String(error)}`);
  }

  private agentOptions(): { provider: string; model: string } {
    if (this.config.model !== undefined) return { ...this.config.model };
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection();
    return { provider, model };
  }

  private ensureAgent(userId: string): Promise<LiveEntry> {
    const existing = this.live.get(userId);
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = this.inflight.get(userId);
    if (pending !== undefined) return pending;
    const created = this.createOrResumeAgent(userId).finally(() => {
      this.inflight.delete(userId);
    });
    this.inflight.set(userId, created);
    return created;
  }

  private async createOrResumeAgent(userId: string): Promise<LiveEntry> {
    const stored = await this.store.get(userId);
    if (stored !== undefined && Date.now() - stored.lastActiveMs < this.config.sessionIdleTimeoutMs) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: brandString<SessionId>(stored.sessionId),
          agentOptions: this.agentOptions(),
          setup: async (agentCtx: Context) => {
            await this.ctx.agentPresets.mount(agentCtx, this.config.agentPreset);
          },
        });
        return this.remember(userId, handle, stored.sessionId);
      } catch (error) {
        this.ctx.logger.warn(
          `wechat-ilink: resuming session ${JSON.stringify(stored.sessionId)} failed, creating a new one: ${String(error)}`,
        );
      }
    }

    const preset = await this.ctx.agentPresets.resolve(this.config.agentPreset);
    await this.ctx.agentPresets.standingKeyFor(preset.id);
    const cwd = join(this.config.workspaceRoot, sanitizeUserId(userId));
    await mkdir(cwd, { recursive: true });
    const workspace = await this.ctx.workspaceRegistry.create(cwd);
    const sessionId = brandString<SessionId>(`wechat-${randomUUID()}`);
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: this.agentOptions(),
      setup: async (agentCtx: Context) => {
        await this.ctx.agentPresets.mount(agentCtx, preset.id);
      },
    });
    try {
      await workspace.attachSession(sessionId);
      this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset);
      this.ctx.sessionTitle.rename(handle.agent.session, `WeChat ${sanitizeUserId(userId)}`);
    } catch (error) {
      try {
        await handle.dispose();
      } catch {
        // best effort rollback
      }
      throw error;
    }
    return this.remember(userId, handle, sessionId);
  }

  private remember(userId: string, handle: AgentHandle, sessionId: string): LiveEntry {
    const entry = { handle, sessionId, lastActiveMs: Date.now() };
    this.live.set(userId, entry);
    this.sessionOwners.set(sessionId, userId);
    return entry;
  }
}

function sanitizeUserId(userId: string): string {
  const sanitized = userId.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized === "" ? "unknown" : sanitized.slice(0, 64);
}
