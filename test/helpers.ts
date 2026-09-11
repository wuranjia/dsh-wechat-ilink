import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { BridgeConfig, BridgeContext } from "../src/bridge.js";
import type { ReplySession } from "../src/reply.js";

export interface FakeHandle {
  agent: {
    session: { header: { id: string } };
    followup: ReturnType<typeof vi.fn>;
    status: "idle" | "running";
  };
  dispose: ReturnType<typeof vi.fn>;
}

export function makeFakeHandle(sessionId: string): FakeHandle {
  return {
    agent: { session: { header: { id: sessionId } }, followup: vi.fn(), status: "idle" },
    dispose: vi.fn(async () => {}),
  };
}

export interface FakeWorld {
  ctx: BridgeContext;
  create: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  mount: ReturnType<typeof vi.fn>;
  permissionSet: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  attachSession: ReturnType<typeof vi.fn>;
  sender: { send: ReturnType<typeof vi.fn>; sendTyping: ReturnType<typeof vi.fn> };
}

export async function makeFakeWorld(): Promise<{ world: FakeWorld; workspaceRoot: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "wechat-bridge-ws-"));
  const create = vi.fn(
    async (options: { sessionId: string; setup?: (agentCtx: Context, agent: unknown) => unknown }) => {
      const handle = makeFakeHandle(options.sessionId);
      // The real agents.create awaits setup before the handle becomes visible.
      await options.setup?.({} as never, handle.agent);
      return handle;
    },
  );
  const resume = vi.fn(
    async (options: {
      resumeSessionId: string;
      setup?: (agentCtx: Context, agent: unknown) => unknown;
    }) => {
      const handle = makeFakeHandle(options.resumeSessionId);
      // The real agents.resume awaits setup before the handle becomes visible.
      await options.setup?.({} as never, handle.agent);
      return handle;
    },
  );
  const mount = vi.fn(async () => {});
  const permissionSet = vi.fn();
  const rename = vi.fn();
  const attachSession = vi.fn(async () => {});
  const ctx: BridgeContext = {
    // The fake handles are structural stand-ins, not full AgentHandle/Agent —
    // cast at this boundary so the rest of the fake world stays typechecked.
    agents: { create, resume } as unknown as BridgeContext["agents"],
    agentPresets: {
      resolve: vi.fn(async () => ({ id: "standard" })),
      standingKeyFor: vi.fn(async () => ({})),
      mount,
    },
    permissionPresets: { set: permissionSet },
    workspaceRegistry: {
      create: vi.fn(async (path: string) => ({ path, attachSession })),
    },
    sessionTitle: { rename },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
  return {
    world: {
      ctx, create, resume, mount, permissionSet, rename, attachSession,
      sender: { send: vi.fn(async () => {}), sendTyping: vi.fn(async () => {}) },
    },
    workspaceRoot,
  };
}

export function bridgeConfig(workspaceRoot: string, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    allowUsers: new Set(["u1@im.wechat"]),
    workspaceRoot,
    agentPreset: "standard",
    permissionPreset: "wechat-safe",
    sessionIdleTimeoutMs: 1_800_000,
    maxReplyChars: 1800,
    model: undefined,
    ...overrides,
  };
}

export function assistantEvent(
  seq: number,
  turn: number,
  text: string,
  interrupted?: true,
): SessionEvent<"assistant/message"> {
  return {
    type: "assistant/message",
    seq: SessionSeq(seq),
    time: 0,
    surfaceOp: "append",
    data: {
      turn,
      step: 1,
      message: {
        id: MessageId(`m${seq}`),
        role: "assistant",
        content: text === "" ? [] : [{ type: "text", text }],
        source: { kind: "model", provider: "p", model: "m" },
      },
      stream: [],
      interrupted,
    },
  };
}

export function fakeSession(events: readonly SessionEvent[]): ReplySession {
  return {
    snapshotEvents: () => events,
    deriveEventMessage: (event) =>
      event.type === "assistant/message" ? event.data.message : null,
  };
}
