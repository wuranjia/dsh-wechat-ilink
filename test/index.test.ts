import { describe, expect, it, vi } from "vitest";
import type { AskUserQuestionRequest } from "@deepseek-ai/dsh-user-questions";
import { Config, createWeChatAskHandler, resolveModel } from "../src/index.js";

describe("Config", () => {
  it("applies documented defaults for a minimal config", () => {
    const resolved = Config({ allowUsers: ["u1"] }) as Record<string, unknown>;
    expect(resolved.workspaceRoot).toBe("~/Documents/wechat-agent");
    expect(resolved.storageDir).toBe("~/.dsh/wechat-ilink");
    expect(resolved.agentPreset).toBe("standard");
    expect(resolved.permissionPreset).toBe("wechat-safe");
    expect(resolved.sessionIdleTimeoutMs).toBe(1_800_000);
    expect(resolved.maxReplyChars).toBe(1800);
    expect(resolved.logLevel).toBe("info");
    expect(resolved.model).toEqual({ provider: "", model: "" });
  });

  it("rejects a config without allowUsers", () => {
    expect(() => Config({})).toThrow();
  });

  it("rejects an out-of-range timeout", () => {
    expect(() => Config({ allowUsers: ["u1"], sessionIdleTimeoutMs: 1 })).toThrow();
  });
});

describe("resolveModel", () => {
  it("returns the explicit route when both fields are set", () => {
    expect(resolveModel({ provider: "mimo", model: "glm" }, vi.fn())).toEqual({ provider: "mimo", model: "glm" });
  });

  it("returns undefined when neither field is set, without warning", () => {
    const warn = vi.fn();
    expect(resolveModel({ provider: "", model: "" }, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns undefined with a warning when only one field is set", () => {
    const warn = vi.fn();
    expect(resolveModel({ provider: "mimo", model: "" }, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(resolveModel({ provider: "", model: "glm" }, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("Config askMode", () => {
  it("defaults askMode to wechat", () => {
    const resolved = Config({ allowUsers: ["u1"] }) as Record<string, unknown>;
    expect(resolved.askMode).toBe("wechat");
  });

  it("accepts auto and web", () => {
    expect((Config({ allowUsers: ["u1"], askMode: "auto" }) as Record<string, unknown>).askMode).toBe("auto");
    expect((Config({ allowUsers: ["u1"], askMode: "web" }) as Record<string, unknown>).askMode).toBe("web");
  });

  it("rejects an unknown askMode", () => {
    // "always" is deliberately outside the compile-time union; `as never` keeps
    // this a runtime-validation test of the schemastery union.
    expect(() => Config({ allowUsers: ["u1"], askMode: "always" as never })).toThrow();
  });
});

describe("createWeChatAskHandler", () => {
  const agent = { session: { header: { id: "wechat-1" } } } as never;
  const foreign = { session: { header: { id: "gui-session" } } } as never;
  const request = (withAgent: unknown): AskUserQuestionRequest =>
    ({ questions: [{ id: "q1", question: "？", options: [{ label: "甲" }] }], agent: withAgent as never });

  function deps(overrides: Partial<Parameters<typeof createWeChatAskHandler>[0]> = {}) {
    const claimed = Promise.resolve({ answers: [{ id: "q1", selected: ["甲"], custom: undefined }] });
    return {
      askMode: "wechat" as const,
      ownsAgentSession: vi.fn((a: { session: { header: { id: string } } }) => a.session.header.id === "wechat-1"),
      // bridge-shaped double: claims only WeChat-owned agents, declines the rest
      tryClaimQuestion: vi.fn((r: AskUserQuestionRequest) =>
        r.agent !== undefined && r.agent.session.header.id === "wechat-1" ? claimed : undefined),
      ...overrides,
    };
  }

  it("auto-answers WeChat-owned agents in auto mode", async () => {
    const d = deps({ askMode: "auto" });
    const answer = await createWeChatAskHandler(d)(request(agent), vi.fn());
    expect(answer.answers[0].custom).toContain("由你自行决定");
    expect(d.tryClaimQuestion).not.toHaveBeenCalled();
  });

  it("delegates foreign agents to the next answerer even in auto mode", async () => {
    const d = deps({ askMode: "auto" });
    const next = vi.fn(async () => ({ answers: [] }));
    await createWeChatAskHandler(d)(request(foreign), next);
    // the uniform fallthrough still consults tryClaimQuestion; the double
    // declines the foreign agent, so the request delegates to next.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("delegates agentless requests to the next answerer", async () => {
    const d = deps({ askMode: "auto" });
    const next = vi.fn(async () => ({ answers: [] }));
    await createWeChatAskHandler(d)(request(undefined), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("claims WeChat-owned agents in wechat mode and passes rejections through", async () => {
    const rejection = Promise.reject(new Error("ask aborted"));
    const d = deps({ tryClaimQuestion: vi.fn(() => rejection) });
    const next = vi.fn(async () => ({ answers: [] }));
    await expect(createWeChatAskHandler(d)(request(agent), next)).rejects.toThrow("ask aborted");
    expect(next).not.toHaveBeenCalled();
  });
});
