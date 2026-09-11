import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSeq, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import { WeChatBridge } from "../src/bridge.js";
import { JsonFileBridgeStore } from "../src/store.js";
import { assistantEvent, bridgeConfig, fakeSession, makeFakeWorld, type FakeWorld } from "./helpers.js";

let world: FakeWorld;
let workspaceRoot: string;
let store: JsonFileBridgeStore;

beforeEach(async () => {
  const made = await makeFakeWorld();
  world = made.world;
  workspaceRoot = made.workspaceRoot;
  store = new JsonFileBridgeStore(join(workspaceRoot, "state.json"));
  await store.load();
});

describe("WeChatBridge.handleMessage (gating)", () => {
  it("ignores messages from non-allowlisted users", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("stranger@im.wechat", "text", "hi");
    expect(world.create).not.toHaveBeenCalled();
    expect(world.resume).not.toHaveBeenCalled();
    expect(world.sender.send).not.toHaveBeenCalled();
  });

  it("answers non-text messages with an unsupported notice", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "image", "[image]");
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（v1 仅支持文本消息）");
    expect(world.create).not.toHaveBeenCalled();
  });

  it("answers empty text messages with an unsupported notice", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "   ");
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（v1 仅支持文本消息）");
    expect(world.create).not.toHaveBeenCalled();
  });
});

describe("WeChatBridge.handleMessage (create path)", () => {
  it("creates a session under the per-user workspace directory", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    expect(world.create).toHaveBeenCalledTimes(1);
    const options = world.create.mock.calls[0][0] as { sessionId: string; meta: { cwd: string } };
    expect(options.sessionId.startsWith("wechat-")).toBe(true);
    expect(options.meta.cwd).toBe(join(workspaceRoot, "u1_im_wechat"));
    // the per-user directory was created on disk
    await expect(stat(options.meta.cwd)).resolves.toBeTruthy();
  });

  it("sanitizes the user id into the directory name", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot, { allowUsers: new Set(["wxid_abc@im.wechat"]) }), store, world.sender);
    await bridge.handleMessage("wxid_abc@im.wechat", "text", "hi");
    const options = world.create.mock.calls[0][0] as { meta: { cwd: string } };
    expect(options.meta.cwd).toBe(join(workspaceRoot, "wxid_abc_im_wechat"));
  });

  it("sets the permission preset, renames the session, and follows up", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { agent: { session: unknown; followup: ReturnType<typeof vi.fn> } };
    expect(world.permissionSet).toHaveBeenCalledWith(created.agent.session, "wechat-safe");
    expect(world.rename).toHaveBeenCalledWith(created.agent.session, expect.stringContaining("u1_im_wechat"));
    const followup = created.agent.followup as ReturnType<typeof vi.fn>;
    expect(followup).toHaveBeenCalledTimes(1);
    const message = followup.mock.calls[0][0] as { content: { type: string; text: string }[] };
    expect(message.content[0]).toEqual({ type: "text", text: "你好" });
  });

  it("records typing and persists the mapping", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    expect(world.sender.sendTyping).toHaveBeenCalledWith("u1@im.wechat");
    const stored = await store.get("u1@im.wechat");
    expect(stored).toBeDefined();
    expect(stored!.sessionId.startsWith("wechat-")).toBe(true);
  });

  it("reuses the live agent for a second message from the same user", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "一");
    await bridge.handleMessage("u1@im.wechat", "text", "二");
    expect(world.create).toHaveBeenCalledTimes(1);
    const created = (await world.create.mock.results[0].value) as { agent: { followup: ReturnType<typeof vi.fn> } };
    expect(created.agent.followup).toHaveBeenCalledTimes(2);
  });

  it("reports handling failures back to WeChat", async () => {
    world.create.mockRejectedValueOnce(new Error("boom"));
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("处理失败"));
  });
});

describe("WeChatBridge.handleMessage (resume path)", () => {
  it("resumes a stored fresh session instead of creating", async () => {
    await store.set("u1@im.wechat", { sessionId: "wechat-stored", lastActiveMs: Date.now() });
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "继续");
    expect(world.resume).toHaveBeenCalledTimes(1);
    expect(world.resume.mock.calls[0][0]).toMatchObject({
      resumeSessionId: "wechat-stored",
      agentOptions: { provider: "p", model: "m" },
    });
    expect(world.create).not.toHaveBeenCalled();
    expect(world.mount).toHaveBeenCalledTimes(1);
    const resumed = (await world.resume.mock.results[0].value) as { agent: { followup: ReturnType<typeof vi.fn> } };
    expect(resumed.agent.followup).toHaveBeenCalledTimes(1);
  });

  it("creates a new session when the stored one is idle beyond the timeout", async () => {
    await store.set("u1@im.wechat", { sessionId: "wechat-stale", lastActiveMs: Date.now() - 2_000_000 });
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "新话题");
    expect(world.resume).not.toHaveBeenCalled();
    expect(world.create).toHaveBeenCalledTimes(1);
    const stored = await store.get("u1@im.wechat");
    expect(stored!.sessionId).not.toBe("wechat-stale");
  });

  it("falls back to creating when resume fails", async () => {
    await store.set("u1@im.wechat", { sessionId: "wechat-broken", lastActiveMs: Date.now() });
    world.resume.mockRejectedValueOnce(new Error("session gone"));
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    expect(world.resume).toHaveBeenCalledTimes(1);
    expect(world.create).toHaveBeenCalledTimes(1);
  });
});

describe("WeChatBridge concurrency and create-sequence pinning", () => {
  it("deduplicates concurrent messages from one user into a single create", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await Promise.all([
      bridge.handleMessage("u1@im.wechat", "text", "一"),
      bridge.handleMessage("u1@im.wechat", "text", "二"),
    ]);
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.attachSession).toHaveBeenCalledTimes(1);
    const created = (await world.create.mock.results[0].value) as { agent: { followup: ReturnType<typeof vi.fn> } };
    expect(created.agent.followup).toHaveBeenCalledTimes(2);
  });

  it("runs the create setup and attaches the session it created", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    expect(world.mount).toHaveBeenCalledTimes(1);
    const options = world.create.mock.calls[0][0] as { sessionId: string };
    expect(world.attachSession).toHaveBeenCalledWith(options.sessionId);
  });

  it("passes an explicit model override into agentOptions", async () => {
    const bridge = new WeChatBridge(
      world.ctx,
      bridgeConfig(workspaceRoot, { model: { provider: "mimo", model: "glm" } }),
      store,
      world.sender,
    );
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const options = world.create.mock.calls[0][0] as { agentOptions: { provider: string; model: string } };
    expect(options.agentOptions).toEqual({ provider: "mimo", model: "glm" });
  });
});

describe("WeChatBridge.onSessionEvent (reply routing)", () => {
  async function bridgeWithLiveUser(): Promise<{ bridge: WeChatBridge; sessionId: string }> {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const stored = await store.get("u1@im.wechat");
    return { bridge, sessionId: stored!.sessionId };
  }

  function turnEnd(turn: number, reason: TurnEndReason): SessionEvent {
    return { type: "turn/end", seq: SessionSeq(99), time: 0, data: { turn, reason } } as SessionEvent;
  }

  it("sends the turn's assistant text back to the owning user", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "这是回复")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "completed" }));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "这是回复");
  });

  it("ignores events for sessions it does not own", async () => {
    const { bridge } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "text")]);
    bridge.onSessionEvent({ ...session, header: { id: "other-session" } }, turnEnd(1, { kind: "completed" }));
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalled();
  });

  it("sends a no-text notice when the turn produced no assistant text", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "completed" }));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（任务已完成，无文本回复）");
  });

  it("stays silent for aborted turns", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "aborted", reason: { kind: "disposed" } }));
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalled();
  });

  it("reports a failure notice when an error turn produced no text", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "error", error: { message: "boom", code: "UNKNOWN" } }));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（本回合处理失败，未产生回复；可重发消息重试）");
  });

  it("reports a failure notice when a blocked turn produced no text", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "blocked" }));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（本回合处理失败，未产生回复；可重发消息重试）");
  });

  it("stays silent for interrupted turns even with text", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "崩溃前的部分回复")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "interrupted" }));
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalled();
  });

  it("stays silent for aborted turns even with text", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "中止前已完成的回复")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "aborted", reason: { kind: "disposed" } }));
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalled();
  });

  it("appends an error marker when the turn ended in error", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "部分结果")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "error", error: { message: "boom", code: "UNKNOWN" } }));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("部分结果"));
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("错误"));
  });

  it("truncates long replies to maxReplyChars", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "x".repeat(5000))]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, { kind: "completed" }));
    await Promise.resolve();
    const sent = world.sender.send.mock.calls.at(-1)?.[1] as string;
    expect(sent.length).toBeLessThanOrEqual(1800 + 40);
    expect(sent).toContain("已截断");
  });

  it("ignores non turn/end events", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, {
      type: "turn/start", seq: 1 as never, time: 0, data: { turn: 2 },
    } as never);
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalled();
  });
});
