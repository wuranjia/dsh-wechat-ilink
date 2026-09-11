import { describe, expect, it } from "vitest";
import { Config } from "../src/index.js";

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
