import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHandle, CreateAgentOptions, ResumeAgentOptions } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { brandString } from "@deepseek-ai/dsh-brand";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
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

/** The DSH services the bridge uses (satisfied by the real plugin Context). */
// Method syntax is load-bearing: it carries parameter bivariance, which the real Context's branded parameters rely on — do not convert to arrow-function properties.
export interface BridgeContext {
  agents: {
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  };
  agentPresets: {
    resolve(id: string): Promise<{ id: string }>;
    standingKeyFor(id: string): Promise<unknown>;
    mount(agentCtx: Context, id: string): Promise<void>;
  };
  permissionPresets: { set(session: unknown, name: string): void };
  workspaceRegistry: {
    create(path: string): Promise<{ path: string; attachSession(sessionId: string): Promise<void> }>;
  };
  sessionTitle: { rename(session: unknown, title: string): void };
  agentDefaultModel: { currentSelection(): { provider: string; model: string } };
  logger: { debug(message: string): void; warn(message: string): void };
}

interface LiveEntry {
  handle: AgentHandle;
  sessionId: string;
  lastActiveMs: number;
}

const UNSUPPORTED_TYPE_REPLY = "（v1 仅支持文本消息）";
const NO_TEXT_REPLY = "（任务已完成，无文本回复）";

/** One WeChat user ↔ one live DSH agent, with durable session continuity. */
export class WeChatBridge {
  private readonly live = new Map<string, LiveEntry>();
  private readonly sessionOwners = new Map<string, string>();

  constructor(
    private readonly ctx: BridgeContext,
    private readonly config: BridgeConfig,
    private readonly store: BridgeStore,
    private readonly sender: BridgeSender,
  ) {}

  /** Entry point for one incoming WeChat message. */
  async handleMessage(userId: string, type: string, text: string): Promise<void> {
    if (!this.config.allowUsers.has(userId)) {
      this.ctx.logger.debug(`wechat-ilink: ignored message from non-allowlisted user ${JSON.stringify(userId)}`);
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

  private agentOptions(): { provider: string; model: string } {
    if (this.config.model !== undefined) return { ...this.config.model };
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection();
    return { provider, model };
  }

  private readonly inflight = new Map<string, Promise<LiveEntry>>();

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
    await workspace.attachSession(sessionId);
    this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset);
    this.ctx.sessionTitle.rename(handle.agent.session, `WeChat ${sanitizeUserId(userId)}`);
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
