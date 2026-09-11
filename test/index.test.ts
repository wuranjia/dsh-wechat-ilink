import { describe, expect, it, vi } from "vitest";
import { Config, resolveModel } from "../src/index.js";

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
