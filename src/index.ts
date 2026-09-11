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
  model: { provider: string; model: string };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function apply(ctx: Context, config: PluginConfig): void {
  const storageDir = expandHome(config.storageDir);
  const workspaceRoot = expandHome(config.workspaceRoot);
  const model = config.model.provider !== "" && config.model.model !== ""
    ? { provider: config.model.provider, model: config.model.model }
    : undefined;

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

  ctx.effect(() => {
    const sweepTimer = setInterval(() => {
      void bridge.sweepIdle().catch((error) => {
        ctx.logger.warn(`wechat-ilink: idle sweep failed: ${String(error)}`);
      });
    }, 60_000);
    void (async () => {
      await store.load();
      ctx.logger.info(`wechat-ilink: connecting to WeChat iLink (${config.allowUsers.length} allowlisted user(s))`);
      await bot.login();
      bot.onMessage((msg) => {
        void bridge.handleMessage(msg.userId, msg.type, msg.text)
          .catch((error) => ctx.logger.warn(`wechat-ilink: message handling failed: ${String(error)}`));
      });
      await bot.start();
      ctx.logger.info("wechat-ilink: bot is running");
    })().catch((error) => {
      ctx.logger.error(`wechat-ilink: startup failed: ${String(error)}`);
    });
    return () => {
      clearInterval(sweepTimer);
      bot.stop();
      void bridge.dispose().catch(() => {});
    };
  }, "wechat-ilink.lifecycle()");
}
