import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
// Type-only: pull in the Context service augmentations for the injected
// services so `ctx` carries their types. These are devDependencies — the DSH
// host provides the implementations at runtime; the imports erase at build.
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-session-title";
import type {} from "@deepseek-ai/dsh-workspace";
// Type-only: also activates the 'user-questions/request' event augmentation
// (the cordis waterfall signature below depends on it).
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { autoAnswer } from "./ask.js";
import { WeChatBridge } from "./bridge.js";
import { createIlinkBot } from "./ilink.js";
import { JsonFileBridgeStore } from "./store.js";

export const name = "wechat-ilink";

export const inject = [
  "agents",
  "agentPresets",
  "permissionPresets",
  "workspaceRegistry",
  "sessionTitle",
  "agentDefaultModel",
  "sessionPersistence",
];

export const Config = z.object({
  /** WeChat user ids allowed to trigger the agent (find yours in the log). */
  allowUsers: z.array(z.string()).required(),
  workspaceRoot: z.string().default("~/Documents/wechat-agent"),
  storageDir: z.string().default("~/.dsh/wechat-ilink"),
  agentPreset: z.string().default("standard"),
  permissionPreset: z.string().default("wechat-safe"),
  sessionIdleTimeoutMs: z.number().step(1).min(60_000).default(1_800_000),
  maxReplyChars: z.number().step(1).min(100).default(1800),
  logLevel: z.union(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** How ask_user_question reaches the user for WeChat sessions: relay to WeChat, auto-decide, or leave to the Web GUI. */
  askMode: z.union(["wechat", "auto", "web"]).default("wechat"),
  model: z.object({
    provider: z.string().default(""),
    model: z.string().default(""),
  }),
});

export interface PluginConfig {
  allowUsers: string[];
  workspaceRoot: string;
  storageDir: string;
  agentPreset: string;
  permissionPreset: string;
  sessionIdleTimeoutMs: number;
  maxReplyChars: number;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  askMode: "wechat" | "auto" | "web";
  model: { provider: string; model: string };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Decode the nested model config: both fields set → explicit route; neither → undefined; half-set → undefined with a warning. */
export function resolveModel(
  model: { provider: string; model: string },
  warn: (message: string) => void,
): { provider: string; model: string } | undefined {
  if (model.provider !== "" && model.model !== "") return { provider: model.provider, model: model.model };
  if (model.provider !== "" || model.model !== "") {
    warn("wechat-ilink: config model is half-set (provider/model); falling back to the deployment's current model selection");
  }
  return undefined;
}

/** Dependencies the WeChat ask handler needs (satisfied by the bridge + config). */
export interface WeChatAskHandlerDeps {
  askMode: "wechat" | "auto" | "web";
  ownsAgentSession(agent: { session: { header: { id: string } } }): boolean;
  tryClaimQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> | undefined;
}

/**
 * The user-questions waterfall handler: claims WeChat-owned agents'
 * questions (relaying them to WeChat), auto-answers in `auto` mode, and
 * delegates everything else to the next answerer (the Web GUI).
 */
export function createWeChatAskHandler(deps: WeChatAskHandlerDeps) {
  return (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> => {
    if (deps.askMode === "auto" && request.agent !== undefined
      && deps.ownsAgentSession(request.agent)) {
      return Promise.resolve(autoAnswer(request.questions));
    }
    // in auto mode tryClaimQuestion never claims (owned agents were answered above); the uniform path keeps agentless requests delegating correctly
    const claimed = deps.tryClaimQuestion(request);
    return claimed === undefined ? next() : claimed;
  };
}

export function apply(ctx: Context, config: PluginConfig): void {
  const storageDir = expandHome(config.storageDir);
  const workspaceRoot = expandHome(config.workspaceRoot);
  const model = resolveModel(config.model, (message) => ctx.logger.warn(message));

  const bot = createIlinkBot({ storageDir, logLevel: config.logLevel });
  const store = new JsonFileBridgeStore(join(storageDir, "bridge-state.json"));
  const bridge = new WeChatBridge(ctx, {
    allowUsers: new Set(config.allowUsers),
    workspaceRoot,
    agentPreset: config.agentPreset,
    permissionPreset: config.permissionPreset,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    maxReplyChars: config.maxReplyChars,
    model,
  }, store, {
    send: (userId, text) => bot.send(userId, text),
    sendTyping: (userId) => bot.sendTyping(userId),
  });

  bot.on("error", (error) => ctx.logger.warn(`wechat-ilink: bot error: ${String(error)}`));
  bot.on("session:expired", () => {
    ctx.logger.warn("wechat-ilink: iLink session expired; the SDK will re-login (scan the new QR code)");
  });

  ctx.on("session/event", (session, event) => bridge.onSessionEvent(session, event));

  if (config.askMode !== "web") {
    ctx.on("user-questions/request", createWeChatAskHandler({
      askMode: config.askMode,
      ownsAgentSession: (agent) => bridge.ownsAgentSession(agent),
      tryClaimQuestion: (request) => bridge.tryClaimQuestion(request),
    }), { prepend: true });
  }

  ctx.effect(() => {
    let active = true;
    const sweepTimer = setInterval(() => {
      void bridge.sweepIdle().catch((error) => {
        ctx.logger.warn(`wechat-ilink: idle sweep failed: ${String(error)}`);
      });
    }, 60_000);
    void (async () => {
      await store.load();
      if (!active) return;
      ctx.logger.info(`wechat-ilink: connecting to WeChat iLink (${config.allowUsers.length} allowlisted user(s))`);
      await bot.login();
      if (!active) return;
      bot.onMessage((msg) => {
        void bridge.handleMessage(msg.userId, msg.type, msg.text)
          .catch((error) => ctx.logger.warn(`wechat-ilink: message handling failed: ${String(error)}`));
      });
      await bot.start();
      if (!active) return;
      ctx.logger.info("wechat-ilink: bot is running");
    })().catch((error) => {
      ctx.logger.error(`wechat-ilink: startup failed: ${String(error)}`);
    });
    return () => {
      active = false;
      clearInterval(sweepTimer);
      bot.stop();
      void bridge.dispose().catch(() => {});
    };
  }, "wechat-ilink.lifecycle()");
}
