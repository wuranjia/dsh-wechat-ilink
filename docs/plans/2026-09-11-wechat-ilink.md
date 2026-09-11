# dsh-wechat-ilink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 DSH cordis 插件，把微信 iLink 机器人消息桥接到 per-user 持久 DSH 会话，并把 agent 回复发回微信。

**Architecture:** 插件装进 web profile。`WeChatBot` SDK（`@wechatbot/wechatbot`）负责 iLink 协议（扫码登录/长轮询/发送）；`WeChatBridge` 维护 user→agent 映射，用 `ctx.agents.create/resume` 管理会话；订阅全局 `session/event`，在 `turn/end` 时提取该 turn 的 assistant 文本发回微信。

**Tech Stack:** TypeScript (NodeNext, Node ≥ 22)、cordis 插件、`@wechatbot/wechatbot` ^2.2.0、`qrcode-terminal`、vitest。

**Spec:** `docs/specs/2026-09-11-wechat-ilink-design.md`（本计划修正其中一处：`agentPreset` 默认值是 `standard` 而非 `default`，已从 web-app bundle 配置核实）。

---

## 前置事实（实现者必读，全部已核实）

**DSH 插件形态**（参照 `@deepseek-ai/dsh-webhook-github`）：ESM 包，入口导出
`name`（string）、`inject`（string[]，服务名）、`Config`（schemastery schema）、
`apply(ctx, config)`。清理用 `ctx.effect(() => disposer, "label")`。

**Agent API**（`@deepseek-ai/dsh-agent`，web profile 内全部可用）：
- `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })` → `AgentHandle { agent, dispose() }`
- `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` → AgentHandle（需要 inject `sessionPersistence`；resume 不需要重新 attachSession）
- `agent.followup(userMessage)` 排队一个 turn；`agent.session.header.id` 是会话 id
- `sessionId` 用 `brandString()`（`@deepseek-ai/dsh-brand`）打标

**create 路径完整序列**（照抄 `dsh-webhook` 的 `createWebhookSession`）：
```ts
const preset = await ctx.agentPresets.resolve(agentPreset);   // → { id, ... }
await ctx.agentPresets.standingKeyFor(preset.id);
const workspace = await ctx.workspaceRegistry.create(cwd);      // cwd 先 mkdir -p
const handle = await ctx.agents.create({
  sessionId, meta: { cwd: workspace.path, agentPreset: preset.id },
  agentOptions, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id); },
});
await workspace.attachSession(sessionId);
ctx.permissionPresets.set(handle.agent.session, permissionPreset);  // 持久化，resume 不需要重设
ctx.sessionTitle.rename(handle.agent.session, title);
```

**用户消息构造**（`@deepseek-ai/dsh-llm`）：
```ts
createUserMessage({
  content: [{ type: "text", text }],
  source: { kind: "plugin", plugin: "wechat-ilink", form: "notice",
            summary: boundContextSummary(`WeChat message from ${userId}`) },
})
```
（`kind: "plugin"` 是内置类型，无需模块增强；`summary` 上限 120 字符。）

**回复提取**：插件 ctx 上 `ctx.on("session/event", (session, event) => ...)`（全局
firehose，参照 dsh-acp 按 `session.header.id` 过滤）。**事件 payload 嵌套在
`event.data` 下**（`SessionEvent = {type, seq, time, data, ignorable?}`）：
`turn/end` 的 turn/reason 在 `event.data`；`assistant/message` 的 turn/message
在 `event.data.turn`/`event.data.message`。`session.snapshotEvents()` 返回全部
事件；`session.deriveEventMessage(event)` 把 `assistant/message` 事件转成
Message，其 `content` 里 `type === "text"` 的块有 `.text`。`Message` 类型从
`@deepseek-ai/dsh-llm` 导入（dsh-session 只重导出 Assistant/User/System/
ToolResult 特化类型，不导出基础 Message）。turn 结束时该 turn 的 assistant 事件
已在 log 里。

**agentOptions**：`config.model` 未设时用
`ctx.agentDefaultModel.currentSelection()` → `{ provider, model }`。

**schemastery 陷阱**：嵌套 object 字段缺省时会物化为 `{}` 并校验内层——内层
必填字段会炸。解决：内层字段全部 `.default("")`，代码里空串视为未设置。
`z.array(z.string()).required()`、`z.number().step(1).min(x).default(y)`、
`z.union(["a","b"]).default("a")` 均已验证可用。

**web profile 事实**：agent preset 默认名 `standard`；permission-presets 行 id 是
`permission`（用户 patch 按 id 覆盖整行 config）；沙箱 workspace-write 的根跟随
`session.header.cwd`（每用户子目录即沙箱边界）；profile 在
`~/.dsh/profiles/web/`，`patchReload: live`。

**SDK 事实**（`@wechatbot/wechatbot` 2.2.0，已装包核实类型）：
- `new WeChatBot({ storage: "file", storageDir, logLevel, loginCallbacks: { onQrUrl, onScanned, onExpired } })`
- `await bot.login()`（有凭证自动恢复）/ `await bot.start()` / `bot.stop()`
- `bot.onMessage((msg: IncomingMessage) => ...)`，`msg: { userId, text, type: "text"|"image"|"voice"|"file"|"video", ... }`
- `await bot.send(userId, text)`（按用户缓存 context_token，适合延迟回复）
- `await bot.sendTyping(userId)`
- `bot.on("error" | "session:expired" | "session:restored" | "close", ...)`

**工程根目录**：`/Users/zym/Documents/20260823/dsh-wechat-ilink/`（已 git init）。

---

### Task 1: 工程脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `src/index.ts`（占位导出，Task 9 重写）

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "dsh-wechat-ilink",
  "version": "0.1.0",
  "description": "WeChat iLink bot bridge plugin for DeepSeek Harness",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@deepseek-ai/dsh-brand": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.1",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@wechatbot/wechatbot": "^2.2.0",
    "qrcode-terminal": "^0.12.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.1",
    "@types/node": "^22.0.0",
    "@types/qrcode-terminal": "^0.12.2",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json（typecheck 用，含 test/）与 tsconfig.build.json（出 lib/）**

`tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`tsconfig.build.json`：
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "declaration": true, "outDir": "lib" },
  "include": ["src"]
}
```

`.gitignore`：
```
node_modules/
lib/
*.tgz
```

`src/index.ts`（占位，Task 9 重写）：
```ts
export const name = "wechat-ilink";
```

- [ ] **Step 3: 安装依赖并验证**

Run: `cd /Users/zym/Documents/20260823/dsh-wechat-ilink && pnpm install`
（若无 pnpm 用 `npm install`）
Expected: 依赖装好，无 peer 冲突。

Run: `pnpm typecheck`
Expected: 0 errors（占位文件无引用）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold dsh-wechat-ilink plugin project"
```

---

### Task 2: store.ts — user→session 持久化映射

**Files:**
- Create: `src/store.ts`, `test/store.test.ts`

- [ ] **Step 1: 写失败测试 `test/store.test.ts`**

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileBridgeStore } from "../src/store.js";

let dir: string;
afterEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wechat-store-"));
});

describe("JsonFileBridgeStore", () => {
  it("loads empty state when the file is missing", async () => {
    const store = new JsonFileBridgeStore(join(dir, "state.json"));
    await store.load();
    expect(await store.get("u1")).toBeUndefined();
  });

  it("round-trips set entries across instances", async () => {
    const file = join(dir, "state.json");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    await store.set("u1", { sessionId: "wechat-a", lastActiveMs: 123 });
    await store.set("u2", { sessionId: "wechat-b", lastActiveMs: 456 });

    const reloaded = new JsonFileBridgeStore(file);
    await reloaded.load();
    expect(await reloaded.get("u1")).toEqual({ sessionId: "wechat-a", lastActiveMs: 123 });
    expect(await reloaded.get("u2")).toEqual({ sessionId: "wechat-b", lastActiveMs: 456 });
  });

  it("delete removes the entry durably", async () => {
    const file = join(dir, "state.json");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    await store.set("u1", { sessionId: "wechat-a", lastActiveMs: 123 });
    await store.delete("u1");
    expect(await store.get("u1")).toBeUndefined();

    const reloaded = new JsonFileBridgeStore(file);
    await reloaded.load();
    expect(await reloaded.get("u1")).toBeUndefined();
  });

  it("tolerates a corrupt file by starting empty", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, "{not json", "utf8");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    expect(await store.get("u1")).toBeUndefined();
  });

  it("skips invalid records but keeps valid ones", async () => {
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify({
      good: { sessionId: "wechat-a", lastActiveMs: 1 },
      badNoSession: { lastActiveMs: 2 },
      badNotObject: 42,
    }), "utf8");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    expect(await store.get("good")).toEqual({ sessionId: "wechat-a", lastActiveMs: 1 });
    expect(await store.get("badNoSession")).toBeUndefined();
    expect(await store.get("badNotObject")).toBeUndefined();
  });

  it("writes the state file under the store directory", async () => {
    const file = join(dir, "state.json");
    const store = new JsonFileBridgeStore(file);
    await store.load();
    await store.set("u1", { sessionId: "wechat-a", lastActiveMs: 7 });
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.u1).toEqual({ sessionId: "wechat-a", lastActiveMs: 7 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: FAIL — 无法解析 `../src/store.js`。

- [ ] **Step 3: 实现 `src/store.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Durable per-user bridge state. */
export interface StoredUserState {
  sessionId: string;
  lastActiveMs: number;
}

export interface BridgeStore {
  get(userId: string): Promise<StoredUserState | undefined>;
  set(userId: string, state: StoredUserState): Promise<void>;
  delete(userId: string): Promise<void>;
}

/** JSON-file backed BridgeStore; call load() once before use. */
export class JsonFileBridgeStore implements BridgeStore {
  private readonly cache = new Map<string, StoredUserState>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return; // missing file → start empty
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file → start empty
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
      if (typeof record.lastActiveMs !== "number" || !Number.isSafeInteger(record.lastActiveMs)) continue;
      this.cache.set(userId, { sessionId: record.sessionId, lastActiveMs: record.lastActiveMs });
    }
  }

  async get(userId: string): Promise<StoredUserState | undefined> {
    return this.cache.get(userId);
  }

  async set(userId: string, state: StoredUserState): Promise<void> {
    this.cache.set(userId, state);
    await this.persist();
  }

  async delete(userId: string): Promise<void> {
    this.cache.delete(userId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const record: Record<string, StoredUserState> = {};
    for (const [userId, state] of this.cache) record[userId] = state;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm test`
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: durable user-to-session bridge store"
```

---

### Task 3: reply.ts — 回复提取与截断

**Files:**
- Create: `src/reply.ts`, `test/reply.test.ts`

- [ ] **Step 1: 写失败测试 `test/reply.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { extractTurnReply, messageText, truncateForWeChat, type ReplySession } from "../src/reply.js";
import { MessageId, ToolCallId, type Message } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";

function assistantEvent(
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

function fakeSession(events: readonly SessionEvent[]): ReplySession {
  return {
    snapshotEvents: () => events,
    deriveEventMessage: (event) =>
      event.type === "assistant/message" ? event.data.message : null,
  };
}

describe("messageText", () => {
  it("joins text blocks and ignores other blocks", () => {
    const message: Message = {
      id: MessageId("m"),
      role: "assistant",
      content: [
        { type: "text", text: "hello " },
        { type: "tool-call", id: ToolCallId("c"), name: "t", arguments: "{}" },
        { type: "text", text: "world" },
      ],
      source: { kind: "model", provider: "p", model: "m" },
    };
    expect(messageText(message)).toBe("hello world");
  });
});

describe("extractTurnReply", () => {
  it("returns the last non-empty assistant text of the turn", () => {
    const session = fakeSession([
      assistantEvent(1, 1, "turn one reply"),
      assistantEvent(2, 2, "first step text"),
      assistantEvent(3, 2, "final answer"),
    ]);
    expect(extractTurnReply(session, 2)).toBe("final answer");
  });

  it("skips assistant messages belonging to other turns", () => {
    const session = fakeSession([
      assistantEvent(1, 1, "turn one"),
      assistantEvent(2, 2, ""),
    ]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });

  it("falls back to an earlier non-empty text when the last is empty", () => {
    const session = fakeSession([
      assistantEvent(1, 2, "earlier text"),
      assistantEvent(2, 2, ""),
    ]);
    expect(extractTurnReply(session, 2)).toBe("earlier text");
  });

  it("returns null when the turn has no assistant text at all", () => {
    const session = fakeSession([assistantEvent(1, 2, "")]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });

  it("skips interrupted messages and falls back to the last complete one", () => {
    const session = fakeSession([
      assistantEvent(1, 2, "complete text"),
      assistantEvent(2, 2, "partial frag", true),
    ]);
    expect(extractTurnReply(session, 2)).toBe("complete text");
  });

  it("returns null when every assistant message in the turn was interrupted", () => {
    const session = fakeSession([assistantEvent(1, 2, "frag", true)]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });

  it("returns null for an empty event log", () => {
    expect(extractTurnReply(fakeSession([]), 1)).toBeNull();
  });

  it("treats whitespace-only text as empty", () => {
    const session = fakeSession([assistantEvent(1, 2, "   ")]);
    expect(extractTurnReply(session, 2)).toBeNull();
  });
});

describe("truncateForWeChat", () => {
  it("keeps short text unchanged", () => {
    expect(truncateForWeChat("短回复", 100)).toBe("短回复");
  });

  it("returns text unchanged at the exact boundary", () => {
    const text = "x".repeat(100);
    expect(truncateForWeChat(text, 100)).toBe(text);
  });

  it("truncates long text with a marker", () => {
    const text = "x".repeat(250);
    const result = truncateForWeChat(text, 100);
    expect(result.length).toBeLessThanOrEqual(100 + 30);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result).toContain("已截断");
  });

  it("does not split a surrogate pair when truncating", () => {
    const result = truncateForWeChat("a".repeat(99) + "😀", 100);
    // Cutting at 100 units would orphan 😀's high surrogate; back off to 99.
    expect(result.startsWith("a".repeat(99) + "\n\n")).toBe(true);
    expect(result).toContain("已截断");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: FAIL — 无法解析 `../src/reply.js`。

- [ ] **Step 3: 实现 `src/reply.ts`**

```ts
import type { Message } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * The minimal session surface reply extraction needs (satisfied by real Session).
 * Method syntax is load-bearing: parameter bivariance makes the real Session's
 * branded params compatible; property-syntax arrow functions would break
 * assignability from the real Session.
 */
export interface ReplySession {
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[];
  deriveEventMessage(event: SessionEvent): Message | null;
}

/** Concatenate the text blocks of one message. */
export function messageText(message: Message): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/**
 * Extract the reply text for one finished turn: the last non-empty
 * assistant text in that turn's log (multi-step turns may end on a
 * tool-call-only step, so scan backwards). Interrupted messages — a turn
 * cancelled mid-stream finalizes its partial text with `interrupted: true` —
 * are skipped so earlier complete messages of the turn win.
 */
export function extractTurnReply(session: ReplySession, turn: number): string | null {
  const events = session.snapshotEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "assistant/message") continue;
    if (event.data.turn !== turn) continue;
    if (event.data.interrupted === true) continue;
    const message = session.deriveEventMessage(event);
    if (message === null || message.role !== "assistant") continue;
    const text = messageText(message);
    if (text.trim() !== "") return text;
  }
  return null;
}

/**
 * Truncate a reply for WeChat with an explicit marker.
 *
 * `maxChars` counts UTF-16 code units and is a soft limit: the result keeps
 * at most `maxChars` units of `text` and may exceed that by the fixed marker.
 * A surrogate pair straddling the cut is kept whole by backing off one unit.
 */
export function truncateForWeChat(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n\n（已截断，完整内容见 DSH 会话）`;
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm test`
Expected: 全部 passed（store 6 + reply 13）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: turn reply extraction and WeChat truncation"
```

---

### Task 4: bridge.ts — 消息处理与新会话创建

**Files:**
- Create: `src/bridge.ts`, `test/bridge.test.ts`, `test/helpers.ts`

- [ ] **Step 1: 写测试替身工厂 `test/helpers.ts`**

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { BridgeConfig, BridgeContext } from "../src/bridge.js";

export interface FakeHandle {
  agent: { session: { header: { id: string } }; followup: ReturnType<typeof vi.fn> };
  dispose: ReturnType<typeof vi.fn>;
}

export function makeFakeHandle(sessionId: string): FakeHandle {
  return {
    agent: { session: { header: { id: sessionId } }, followup: vi.fn() },
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
  const create = vi.fn(async (options: { sessionId: string }) => makeFakeHandle(options.sessionId));
  const resume = vi.fn(async (options: { resumeSessionId: string }) => makeFakeHandle(options.resumeSessionId));
  const mount = vi.fn(async () => {});
  const permissionSet = vi.fn();
  const rename = vi.fn();
  const attachSession = vi.fn(async () => {});
  const ctx: BridgeContext = {
    agents: { create, resume },
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
    logger: { debug: vi.fn(), warn: vi.fn() },
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
```

- [ ] **Step 2: 写失败测试 `test/bridge.test.ts`（消息处理 + create 路径）**

```ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("wxid_abc@im.wechat", "text", "hi");
    const options = world.create.mock.calls[0][0] as { meta: { cwd: string } };
    expect(options.meta.cwd).toBe(join(workspaceRoot, "wxid_abc_im_wechat"));
  });

  it("sets the permission preset, renames the session, and follows up", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const handle = world.create.mock.calls[0][0] as unknown as { sessionId: string };
    const created = (await world.create.mock.results[0].value) as { agent: { session: unknown } };
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
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm test`
Expected: FAIL — 无法解析 `../src/bridge.js`。

- [ ] **Step 4: 实现 `src/bridge.ts`（本任务含 gating + create 路径；resume/sweep 在后续任务扩展）**

```ts
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

  private async ensureAgent(userId: string): Promise<LiveEntry> {
    const existing = this.live.get(userId);
    if (existing !== undefined) return existing;

    const preset = await this.ctx.agentPresets.resolve(this.config.agentPreset);
    await this.ctx.agentPresets.standingKeyFor(preset.id);
    const cwd = join(this.config.workspaceRoot, sanitizeUserId(userId));
    await mkdir(cwd, { recursive: true });
    const workspace = await this.ctx.workspaceRegistry.create(cwd);
    const sessionId = brandString(`wechat-${randomUUID()}`);
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
```

- [ ] **Step 5: 运行测试通过**

Run: `pnpm test`
Expected: 全部 passed（store 6 + reply 7 + bridge 9）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: bridge message gating and new-session creation"
```

---

### Task 5: bridge.ts — resume 路径（持久会话恢复）

**Files:**
- Modify: `src/bridge.ts`（扩展 `ensureAgent`）
- Modify: `test/bridge.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试到 `test/bridge.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: resume 3 个用例 FAIL（当前总是走 create）。

- [ ] **Step 3: 扩展 `ensureAgent`——在 create 分支前插入 resume 分支**

把 `src/bridge.ts` 的 `ensureAgent` 开头（`const existing ...` 之后）改为：

```ts
  private async ensureAgent(userId: string): Promise<LiveEntry> {
    const existing = this.live.get(userId);
    if (existing !== undefined) return existing;

    const stored = await this.store.get(userId);
    if (stored !== undefined && Date.now() - stored.lastActiveMs < this.config.sessionIdleTimeoutMs) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: brandString(stored.sessionId) as SessionId,
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
    // …以下 create 分支保持 Task 4 原样
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm test`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: resume stored per-user sessions within the idle window"
```

---

### Task 6: bridge.ts — turn/end 回复路由

**Files:**
- Modify: `src/bridge.ts`（新增 `onSessionEvent`）
- Modify: `test/bridge.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试到 `test/bridge.test.ts`**

先在文件顶部补导入：

```ts
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { assistantEvent, fakeSession } from "./helpers.js";
```

（把 Task 3 的 `assistantEvent`/`fakeSession` 从 `test/reply.test.ts` 挪进
`test/helpers.ts` 导出，两个测试文件共用——移动代码，不是复制。）

```ts
describe("WeChatBridge.onSessionEvent (reply routing)", () => {
  async function bridgeWithLiveUser(): Promise<{ bridge: WeChatBridge; sessionId: string }> {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const stored = await store.get("u1@im.wechat");
    return { bridge, sessionId: stored!.sessionId };
  }

  function turnEnd(turn: number, reason: string): SessionEvent {
    return { type: "turn/end", seq: 99 as never, time: 0, data: { turn, reason: { kind: reason } } } as never;
  }

  it("sends the turn's assistant text back to the owning user", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "这是回复")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, "stop"));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "这是回复");
  });

  it("ignores events for sessions it does not own", async () => {
    const { bridge } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "text")]);
    bridge.onSessionEvent({ ...session, header: { id: "other-session" } }, turnEnd(1, "stop"));
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalledWith(expect.anything(), "text");
  });

  it("sends a no-text notice when the turn produced no assistant text", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, "stop"));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", "（任务已完成，无文本回复）");
  });

  it("stays silent for aborted turns", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, "aborted"));
    await Promise.resolve();
    expect(world.sender.send).not.toHaveBeenCalled();
  });

  it("appends an error marker when the turn ended in error", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "部分结果")]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, "error"));
    await Promise.resolve();
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("部分结果"));
    expect(world.sender.send).toHaveBeenCalledWith("u1@im.wechat", expect.stringContaining("错误"));
  });

  it("truncates long replies to maxReplyChars", async () => {
    const { bridge, sessionId } = await bridgeWithLiveUser();
    const session = fakeSession([assistantEvent(1, 1, "x".repeat(5000))]);
    bridge.onSessionEvent({ ...session, header: { id: sessionId } }, turnEnd(1, "stop"));
    await Promise.resolve();
    const sent = world.sender.send.mock.calls.at(-1)?.[1] as string;
    expect(sent.length).toBeLessThanOrEqualTo(1800 + 40);
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: 新增 7 个用例 FAIL（`onSessionEvent` 不存在）。

- [ ] **Step 3: 在 `WeChatBridge` 类中实现 `onSessionEvent`（放在 `handleMessage` 之后）**

```ts
  /** `session/event` firehose entry; routes finished turns back to WeChat. */
  onSessionEvent(session: ReplySession & { header: { id: string } }, event: SessionEvent): void {
    if (event.type !== "turn/end") return;
    const userId = this.sessionOwners.get(session.header.id);
    if (userId === undefined) return;
    const text = extractTurnReply(session, event.data.turn);
    const failed = event.data.reason.kind === "error";
    if (text === null) {
      if (event.data.reason.kind === "aborted") return;
      void this.sender.send(userId, NO_TEXT_REPLY)
        .catch((error) => this.replyFailed(userId, error));
      return;
    }
    const body = failed ? `${text}\n\n（本回合以错误结束）` : text;
    void this.sender.send(userId, truncateForWeChat(body, this.config.maxReplyChars))
      .catch((error) => this.replyFailed(userId, error));
  }

  private replyFailed(userId: string, error: unknown): void {
    this.ctx.logger.warn(`wechat-ilink: reply to ${JSON.stringify(userId)} failed: ${String(error)}`);
  }
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm test`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: route finished turns back to WeChat"
```

---

### Task 7: bridge.ts — 空闲清理与卸载

**Files:**
- Modify: `src/bridge.ts`（新增 `sweepIdle` / `dispose`）
- Modify: `test/bridge.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试到 `test/bridge.test.ts`**

```ts
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

  it("dispose() tears down every live agent", async () => {
    const bridge = new WeChatBridge(world.ctx, bridgeConfig(workspaceRoot), store, world.sender);
    await bridge.handleMessage("u1@im.wechat", "text", "你好");
    const created = (await world.create.mock.results[0].value) as { dispose: ReturnType<typeof vi.fn> };
    await bridge.dispose();
    expect(created.dispose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: 新增 3 个用例 FAIL（方法不存在）。

- [ ] **Step 3: 在 `WeChatBridge` 类中实现（放在 `onSessionEvent` 之后）**

```ts
  /** Dispose agents idle beyond the timeout; the next message starts a new session. */
  async sweepIdle(now = Date.now()): Promise<void> {
    for (const [userId, entry] of [...this.live]) {
      if (now - entry.lastActiveMs < this.config.sessionIdleTimeoutMs) continue;
      this.forget(userId, entry);
      await this.store.delete(userId);
      try {
        await entry.handle.dispose();
      } catch (error) {
        this.ctx.logger.warn(`wechat-ilink: disposing idle agent for ${JSON.stringify(userId)} failed: ${String(error)}`);
      }
    }
  }

  /** Stop everything (plugin unload). */
  async dispose(): Promise<void> {
    for (const [userId, entry] of [...this.live]) {
      this.forget(userId, entry);
      try {
        await entry.handle.dispose();
      } catch {
        // best effort during teardown
      }
    }
  }

  private forget(userId: string, entry: LiveEntry): void {
    this.live.delete(userId);
    this.sessionOwners.delete(entry.sessionId);
  }
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm test`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: idle sweep and teardown for bridge agents"
```

---

### Task 8: ilink.ts — iLink SDK 封装

**Files:**
- Create: `src/ilink.ts`

纯封装（SDK 已有 77 个测试），只做二维码呈现，不写单元测试；错误路径由
Task 9 的 `bot.on("error")` 兜底。

- [ ] **Step 1: 实现 `src/ilink.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { WeChatBot } from "@wechatbot/wechatbot";

export interface IlinkBotOptions {
  storageDir: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

/** Create the iLink bot with QR rendering wired to the terminal and a state file. */
export function createIlinkBot(options: IlinkBotOptions): WeChatBot {
  return new WeChatBot({
    storage: "file",
    storageDir: options.storageDir,
    logLevel: options.logLevel,
    loginCallbacks: {
      onQrUrl: (url) => {
        void presentQrCode(url, options.storageDir);
      },
      onScanned: () => {
        console.error("[wechat-ilink] QR code scanned; awaiting confirmation…");
      },
      onExpired: () => {
        console.error("[wechat-ilink] QR code expired; requesting a new one…");
      },
    },
  });
}

async function presentQrCode(url: string, storageDir: string): Promise<void> {
  console.error("[wechat-ilink] Scan this QR code with WeChat to log in:");
  qrcode.generate(url, { small: true }, (code) => console.error(code));
  console.error(`[wechat-ilink] QR URL: ${url}`);
  try {
    await mkdir(storageDir, { recursive: true });
    await writeFile(join(storageDir, "login-qr.txt"), `${url}\n`, "utf8");
  } catch {
    // The terminal QR is the primary surface; the file is best effort.
  }
}
```

- [ ] **Step 2: typecheck 通过**

Run: `pnpm typecheck`
Expected: 0 errors。若 `qrcode-terminal` 默认导入报错，确认
`tsconfig.json` 已有 `"esModuleInterop": true`。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: iLink SDK wrapper with terminal QR login"
```

---

### Task 9: index.ts — 插件入口

**Files:**
- Modify: `src/index.ts`（整体重写）
- Create: `test/index.test.ts`

- [ ] **Step 1: 写失败测试 `test/index.test.ts`（Config 默认值与展开逻辑）**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: FAIL — 当前 index.ts 只有占位 `name` 导出。

- [ ] **Step 3: 重写 `src/index.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
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
```

- [ ] **Step 4: 运行测试与 typecheck 通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 passed，0 type errors。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cordis plugin entry wiring iLink bot to bridge"
```

---

### Task 10: README、构建与打包

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 `README.md`**

````markdown
# dsh-wechat-ilink

把微信消息接入 DeepSeek Harness（DSH）的 cordis 插件。微信用户发消息给
iLink bot，插件为该用户维护一个持久 DSH 会话（空闲 30 分钟后自动开新会话），
agent 处理完成后把最终回复发回微信。

- 协议：微信官方 iLink（智联）机器人协议，经 `@wechatbot/wechatbot` SDK
- 会话：每用户一个持久 DSH 会话，重启后自动恢复记忆
- 权限：`wechat-safe` preset（workspace-write 沙箱 + 需审批操作直接失败）
- v1 仅支持文本消息

## 安装

```sh
cd /Users/zym/Documents/20260823/dsh-wechat-ilink
pnpm install && pnpm test && pnpm build && pnpm pack
dsh plugin --profile web add ./dsh-wechat-ilink-0.1.0.tgz
```

然后编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# 追加 wechat-safe 权限 preset（按 id 覆盖整行 config，必须重述全部 preset）
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
      wechat-safe: { sandbox: workspace-write, approval: never }

- insert:
    - id: wechat-ilink
      name: 'dsh-wechat-ilink'
      config:
        allowUsers: []            # ← 填你的微信用户 ID（首启看日志找）
        workspaceRoot: '~/Documents/wechat-agent'
        storageDir: '~/.dsh/wechat-ilink'
        agentPreset: 'standard'
        permissionPreset: 'wechat-safe'
        sessionIdleTimeoutMs: 1800000
        maxReplyChars: 1800
        # model: { provider: 'mimo', model: 'glm_5p2_reasoner_test' }  # 可选
```

验证配置组合（不启动）：

```sh
dsh --profile web --dump-config
```

重启 `dsh web`，在启动它的终端里扫码登录。

## 首次使用

1. 启动后终端出现二维码（也写入 `~/.dsh/wechat-ilink/login-qr.txt`），微信扫码确认。
2. 用白名单外的微信给 bot 发一条消息，日志会打出
   `ignored message from non-allowlisted user "…@im.wechat"`——把该 ID 填进
   `allowUsers`（patchReload: live 会热加载；不行就重启）。
3. 白名单内用户发消息，agent 处理后回复到达微信；Web GUI 里可见同名会话。

## 卸载

```sh
dsh plugin --profile web remove dsh-wechat-ilink
```
并删除 `cordis.patch.yml` 中对应条目。

## 安全须知

iLink 凭证存于 `storageDir`，可完全操控该微信账号——不要提交到任何仓库。
`wechat-safe` 让需要审批的操作直接失败（fail-closed），因为微信侧无人审批。
````

- [ ] **Step 2: 构建 + 打包**

Run: `pnpm build && pnpm pack`
Expected: `lib/` 生成 `index.js`/`index.d.ts` 等；产出
`dsh-wechat-ilink-0.1.0.tgz`。

Run: `node -e "import('./lib/index.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'name', 'inject', 'Config', 'apply' ]`（顺序可不同）。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README with install and first-run guide"
```

---

### Task 11: 安装到 web profile 与端到端验证

**Files:**
- Modify: `~/.dsh/profiles/web/package.json`（经 dsh plugin，自动）
- Modify: `~/.dsh/profiles/web/cordis.patch.yml`（手动）

- [ ] **Step 1: 安装 tarball 到 web profile**

Run: `dsh plugin --profile web add /Users/zym/Documents/20260823/dsh-wechat-ilink/dsh-wechat-ilink-0.1.0.tgz`
（若 `dsh` 不在 PATH：`npx @deepseek-ai/dsh plugin --profile web add …`）
Expected: pnpm 在 profile 目录装好包，`package.json` 出现
`dsh-wechat-ilink` 依赖。

- [ ] **Step 2: 写 profile patch**

按 Task 10 README 的 YAML 编辑 `~/.dsh/profiles/web/cordis.patch.yml`
（当前内容是注释 + `[]`，替换为两条目；`allowUsers` 先留空数组）。

- [ ] **Step 3: 验证配置组合（不启动）**

Run: `dsh --profile web --dump-config`
Expected: 打印的组合树包含 `wechat-ilink` 行且无 schema 报错。
若报 `allowUsers missing required value` 之类，检查 YAML 缩进。

- [ ] **Step 4: 重启并扫码（用户操作）**

重启 `dsh web`（当前 GUI 会话会断开，属预期）。在启动终端扫码登录。

- [ ] **Step 5: 端到端验收清单**

1. 非白名单微信号发消息 → 无回复，日志出现 `ignored message from non-allowlisted user "…"`。
2. 把日志中的 userId 填进 `allowUsers`（热加载或重启）。
3. 白名单用户发「你好」→ 微信收到 agent 回复；GUI 出现 `WeChat <id>` 会话。
4. 紧接着发「我刚才说了什么？」→ 回复引用上一条（记忆延续）。
5. 等 30 分钟（或临时把 `sessionIdleTimeoutMs` 调成 60000）再发消息 →
   GUI 出现新会话（旧会话不再续写）。
6. 重启 `dsh web` 后立刻发消息 → 记忆延续（resume 生效）。
7. 发一张图片 → 收到「（v1 仅支持文本消息）」。
8. 长回复 → 截断标记出现。

- [ ] **Step 6: 最终提交**

```bash
cd /Users/zym/Documents/20260823/dsh-wechat-ilink
git add -A && git commit -m "chore: v0.1.0 ready for web profile install" --allow-empty
```

---

## Self-Review 记录

- **Spec 覆盖**：白名单（Task 4）、持久会话+超时（Task 5/7）、事件驱动回复（Task 6）、
  权限 preset（Task 10 patch）、扫码登录（Task 8/11）、重启恢复（Task 2/5）、
  截断（Task 3/6）、错误处理（Task 4/6/9）、README 安装（Task 10）、端到端（Task 11）。
  spec §8 的 v1 范围外项（媒体/命令/群聊/多账号/GUI 二维码）均未纳入 ✓
- **占位符**：无 TBD/TODO；所有代码完整 ✓
- **类型一致性**：`BridgeConfig`/`BridgeContext`/`BridgeSender` 在 helpers、
  bridge、index 间签名一致；`ReplySession` 在 reply 与 bridge 间一致 ✓
- **修正**：spec 中 `agentPreset: 'default'` → 实际默认 `standard`（已核实
  web-app bundle 配置），README 与 Config 均用 `standard`。
