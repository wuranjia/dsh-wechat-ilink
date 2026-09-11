import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WeChatBridge } from "../src/bridge.js";
import { JsonFileBridgeStore } from "../src/store.js";
import { bridgeConfig, makeFakeWorld, type FakeWorld } from "./helpers.js";

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
    expect(world.resume.mock.calls[0][0]).toMatchObject({ resumeSessionId: "wechat-stored" });
    expect(world.create).not.toHaveBeenCalled();
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
