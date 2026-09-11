import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSeq, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { WeChatBridge } from "../src/bridge.js";
import { JsonFileBridgeStore } from "../src/store.js";
import { assistantEvent, bridgeConfig, fakeSession, makeFakeWorld, type FakeHandle, type FakeWorld } from "./helpers.js";

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

function askRequest(overrides: { signal?: AbortSignal } = {}): AskUserQuestionRequest {
  return {
    questions: [{
      id: "q1",
      question: "用哪种方式？",
      options: [{ label: "方案甲" }, { label: "方案乙" }],
    }],
    ...overrides,
  };
}

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

describe("WeChatBridge idle sweeping and disposal", () => {
  it("disposes agents idle beyond the timeout and clears the store", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    await bridge.sweepIdle(Date.now() + 1_900_000);
    expect(created.dispose).toHaveBeenCalledTimes(1);
    expect(await store.get("u1@im.wechat")).toBeUndefined();
    // the next message creates a fresh session
    await bridge.handleMessage("u1@im.wechat", "text", "再来");
    expect(world.create).toHaveBeenCalledTimes(2);
  });

  it("keeps agents active within the timeout", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    await bridge.sweepIdle(Date.now() + 60_000);
    expect(created.dispose).not.toHaveBeenCalled();
    expect(await store.get("u1@im.wechat")).toBeDefined();
  });

  it("skips agents that are still running a turn, even when idle-expired", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as FakeHandle;
    created.agent.status = "running";
    await bridge.sweepIdle(Date.now() + 1_900_000);
    expect(created.dispose).not.toHaveBeenCalled();
    expect(await store.get("u1@im.wechat")).toBeDefined();
  });

  it("dispose() tears down every live agent", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    await bridge.dispose();
    expect(created.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose() waits for an in-flight create and tears it down too", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    const handling = bridge.handleMessage("u1@im.wechat", "text", "你好");
    await bridge.dispose();
    await handling;
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    expect(created.dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores messages after dispose()", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    await bridge.dispose();
    await bridge.handleMessage("u1@im.wechat", "text", "再来");
    expect(world.create).toHaveBeenCalledTimes(1);
    // the stored session must not be silently resumed either — full no-op
    expect(world.resume).not.toHaveBeenCalled();
    expect(world.sender.send).not.toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("处理失败"));
  });

  it("disposes the handle when a post-create step throws", async () => {
    world.attachSession.mockRejectedValueOnce(new Error("attach failed"));
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    expect(created.dispose).toHaveBeenCalledTimes(1);
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("处理失败"));
  });

  it("continues sweeping when one user's store delete fails, and still disposes that handle", async () => {
    const bridge = new WeChatBridge(
      world.ctx,
      bridgeConfig(workspaceRoot, { allowUsers: new Set(["u1@im.wechat", "u2@im.wechat"]) }),
      store,
      world.sender,
    );
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    await bridge.handleMessage("u2@im.wechat", "text", "你好");
    const first = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    const second = (await world.create.mock.results[1].value) as { dispose: ReturnType<typeof vi.fn> };
    // make the FIRST store delete reject (JsonFileBridgeStore persists the whole map; use vi.spyOn on store.delete for the first call)
    const deleteSpy = vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("disk full"));
    await bridge.sweepIdle(Date.now() + 1_900_000);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  it("warns and continues when an idle handle fails to dispose", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    created.dispose.mockRejectedValueOnce(new Error("dispose boom"));
    await bridge.sweepIdle(Date.now() + 1_900_000);
    expect(created.dispose).toHaveBeenCalledTimes(1);
    expect(await store.get("u1@im.wechat")).toBeUndefined();
  });

  it("dispose() keeps store entries so sessions can resume on restart", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    await bridge.dispose();
    expect(await store.get("u1@im.wechat")).toBeDefined();
  });
});

describe("WeChatBridge user-question claiming", () => {
  async function bridgeWithLiveAgent(): Promise<{ bridge: WeChatBridge; agent: unknown }> {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { agent: unknown };
    return { bridge, agent: created.agent };
  }

  it("returns undefined for agentless requests", async () => {
    const { bridge } = await bridgeWithLiveAgent();
    expect(bridge.tryClaimQuestion(askRequest())).toBeUndefined();
  });

  it("returns undefined for agents outside WeChat sessions", async () => {
    const { bridge } = await bridgeWithLiveAgent();
    const foreign = { session: { header: { id: "other-session" } } } as never;
    expect(bridge.tryClaimQuestion({ ...askRequest(), agent: foreign })).toBeUndefined();
  });

  it("sends the formatted question to WeChat and resolves on the user's reply", async () => {
    const { bridge, agent } = await bridgeWithLiveAgent();
    const claimed = bridge.tryClaimQuestion({ ...askRequest(), agent: agent as never });
    expect(claimed).toBeDefined();
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("用哪种方式？"));
    // the user answers with the option number
    await bridge.handleMessage("u1@im.wechat", "text", "1");
    const answer = await claimed!;
    expect(answer.answers[0]).toEqual({ id: "q1", selected: ["方案甲"], custom: undefined });
    // the reply was consumed as the answer, not a followup
    const created = (await world.create.mock.results[0].value) as { agent: { followup: ReturnType<typeof vi.fn> } };
    expect(created.agent.followup).toHaveBeenCalledTimes(1);
  });

  it("keeps the question pending through a non-text reply", async () => {
    const { bridge, agent } = await bridgeWithLiveAgent();
    const claimed = bridge.tryClaimQuestion({ ...askRequest(), agent: agent as never });
    await bridge.handleMessage("u1@im.wechat", "image", "[image]");
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（v1 仅支持文本消息）");
    await bridge.handleMessage("u1@im.wechat", "text", "方案乙");
    const answer = await claimed!;
    expect(answer.answers[0].selected).toEqual(["方案乙"]);
  });

  it("frees the reply path after the question settles", async () => {
    const { bridge, agent } = await bridgeWithLiveAgent();
    const claimed = bridge.tryClaimQuestion({ ...askRequest(), agent: agent as never });
    await bridge.handleMessage("u1@im.wechat", "text", "1");
    await claimed;
    await bridge.handleMessage("u1@im.wechat", "text", "新指令");
    const created = (await world.create.mock.results[0].value) as { agent: { followup: ReturnType<typeof vi.fn> } };
    expect(created.agent.followup).toHaveBeenCalledTimes(2);
  });

  it("rejects and notifies WeChat when the ask is aborted", async () => {
    const { bridge, agent } = await bridgeWithLiveAgent();
    const controller = new AbortController();
    const claimed = bridge.tryClaimQuestion({ ...askRequest(), agent: agent as never, signal: controller.signal });
    controller.abort();
    await expect(claimed).rejects.toThrow();
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（问题已取消）");
    // the reply path is free again
    await bridge.handleMessage("u1@im.wechat", "text", "新指令");
    const created = (await world.create.mock.results[0].value) as { agent: { followup: ReturnType<typeof vi.fn> } };
    expect(created.agent.followup).toHaveBeenCalledTimes(2);
  });

  it("rejects the pending question when the bridge disposes", async () => {
    const { bridge, agent } = await bridgeWithLiveAgent();
    const claimed = bridge.tryClaimQuestion({ ...askRequest(), agent: agent as never });
    await bridge.dispose();
    await expect(claimed).rejects.toThrow();
  });

  it("rejects when the initial question send fails", async () => {
    const { bridge, agent } = await bridgeWithLiveAgent();
    world.sender.send.mockRejectedValueOnce(new Error("network down"));
    const claimed = bridge.tryClaimQuestion({ ...askRequest(), agent: agent as never });
    await expect(claimed).rejects.toThrow("network down");
  });
});
