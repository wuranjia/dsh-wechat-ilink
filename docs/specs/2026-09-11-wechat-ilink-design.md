# dsh-wechat-ilink 设计文档

**日期**：2026-09-11
**状态**：已确认（用户批准于 2026-09-11）

## 1. 目标

把微信消息接入 DeepSeek Harness（DSH）：微信用户给 bot 发消息，插件在 DSH
web profile 内为该用户维护一个持久会话（Session），由 agent 处理后把最终
回复发回微信。通信走微信官方 iLink（智联）机器人协议。

## 2. 已确认的决策

| 决策点 | 选择 |
|---|---|
| 会话模型 | 每微信用户一个持久 DSH 会话；空闲超时（默认 30 分钟）后自动开新会话 |
| iLink 客户端 | 第三方 SDK `@wechatbot/wechatbot`（零运行时依赖，Node ≥ 22） |
| 访问控制 | 微信用户 ID 白名单 + 受限权限 preset |
| 部署形态 | 装进现有 web profile（`dsh plugin --profile web add`） |
| Workspace | 专用根目录下每用户一个子目录 |
| v1 消息类型 | 仅文本；图片/语音/文件回复"暂不支持"（媒体留 v2） |

## 3. 架构

### 3.1 方案选择

- **采用：专用会话桥**。插件直接用 `ctx.agents.create/resume` 管理 per-user
  agent，订阅 `session/event` 事件驱动回复。
- 否决 webhookRuntime：它是 fire-and-forget、每次投递强制新建会话、拿不到
  回复，与持久会话需求矛盾。
- 否决独立网关进程 + headless CLI：headless 每次新会话无记忆，双进程运维。

### 3.2 工程结构

```
dsh-wechat-ilink/
├── package.json            # name: dsh-wechat-ilink
├── tsconfig.json
├── src/
│   ├── index.ts            # cordis 插件入口：name/inject/Config/apply
│   ├── ilink.ts            # WeChatBot SDK 封装：login(扫码)/start/stop
│   ├── bridge.ts           # user→session 映射、agent create/resume、空闲超时
│   ├── reply.ts            # session/event 订阅，turn/end 提取 assistant 文本
│   └── store.ts            # JSON 持久化：映射与最后活跃时间
├── README.md
└── docs/specs/             # 本文档
```

### 3.3 数据流

```
微信用户发消息
  → iLink 长轮询 → SDK onMessage
  → 白名单过滤（allowUsers；不在名单直接忽略，不回复）
  → bridge 查映射：
      ├─ 命中且未超时 → ctx.agents.resume(resumeSessionId)
      └─ 未命中/超时 → ctx.agents.create(sessionId=wechat-<uuid>,
                          meta.cwd = workspaceRoot/<userId>,
                          agentPreset、permissionPreset)
  → agent.followup(text, source.kind="wechat")
  → bot.sendTyping(userId)
  → [agent 执行：调用工具、读写自己的 workspace]
  → session/event: turn/end → reply.ts 提取该 turn 最后一条非空 assistant 文本
  → bot.send(userId, text)（超过 maxReplyChars 截断并附提示；
     用 send 而非 reply：turn 结束时原始 msg 可能已过期，SDK 按用户缓存 context_token）
```

### 3.4 关键设计点

- **回复路由事件驱动**：在 agent 的 setup 里挂 agent 作用域的 `session/event`
  监听（create 与 resume 两条路径都挂），`turn/end` 时按该 turn 的 seq 区间
  提取回复。用户连发多条消息时各自 turn 各自回复，不丢中间回复。
- **权限**：自定义 preset `wechat-safe` = sandbox `workspace-write` +
  approval `never`。需要审批的操作直接失败（fail-closed）而非挂起——微信侧
  无人在场审批。
- **重启恢复**：SDK 凭证由 SDK 自己的 storage 持久化；user→sessionId 映射
  与最后活跃时间由 store.ts 落盘（JSON）。重启后收到消息 → 映射命中 →
  `agents.resume` 延续记忆。iLink 会话过期（errcode -14）由 SDK 自动重登；
  需要重新扫码时，二维码渲染到终端（qrcode-terminal）并写
  `storageDir/login-qr.txt`。
- **并发**：同一用户连发消息由 agent inbox 天然排队（每条消息一个 turn），
  回复按 turn 边界各自发送；不同用户的 agent 相互独立。
- **生命周期**：所有 agent handle 与 SDK 实例都由插件 ctx 拥有，
  `ctx.effect` 登记 disposer，插件卸载（热重载/停机）时级联清理。

## 4. 配置

装进 web profile 后，`~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: wechat-ilink
      name: 'dsh-wechat-ilink'
      config:
        allowUsers: []                   # 必填，微信用户 ID 白名单
        workspaceRoot: '~/Documents/wechat-agent'
        storageDir: '~/.dsh/wechat-ilink'
        agentPreset: 'standard'
        permissionPreset: 'wechat-safe'
        sessionIdleTimeoutMs: 1800000    # 30 分钟
        maxReplyChars: 1800
        # model: { provider: ..., model: ... }   # 可选；缺省用部署当前选择
```

同 patch 中覆盖 `dsh-permission-presets` 行，追加 `wechat-safe`：

```yaml
- id: permission-presets
  config:
    presets:
      workspace-write: { sandbox: workspace-write, approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
      wechat-safe: { sandbox: workspace-write, approval: never }
    defaultPreset: workspace-write
```

（注意：patch 行按 id 覆盖整行 config，所以必须重述全部 preset。）

## 5. 错误处理

| 情形 | 行为 |
|---|---|
| 非白名单用户 | 忽略，不回复，logger.info（实现修正：debug 会被默认日志级别过滤，而该行是发现 userId 的唯一途径） |
| agent create/resume 失败 | `bot.send(userId)` 错误提示文案 |
| turn 结束但无非空 assistant 文本 | 回复固定提示（如"任务已完成（无文本回复）"） |
| 回复超长 | 截断到 maxReplyChars，末尾附"（已截断）" |
| SDK `error` 事件 | logger.warn |
| iLink 会话过期 | SDK 自动重登；需要扫码时输出二维码 |
| 插件卸载 | bot.stop() + 全部 agent handle dispose（effect 级联） |

## 6. 测试

- **单元**：白名单过滤、bridge 映射与超时判定、回复提取（构造 mock
  SessionEvent 序列）、截断逻辑、store 读写。
- **集成**：fake WeChatBot（stub onMessage/reply/sendTyping）+ fake
  `ctx.agents`，验证 create/resume 分支与事件订阅挂载。
- **端到端**：真实微信扫码手动验证（登录、收发、记忆延续、超时重开）。

## 7. 安装与交付

```sh
cd /Users/zym/Documents/20260823/dsh-wechat-ilink
pnpm install && pnpm build && pnpm pack
dsh plugin --profile web add ./dsh-wechat-ilink-<version>.tgz
# 编辑 ~/.dsh/profiles/web/cordis.patch.yml（见上）
# 重启 dsh web，终端扫码登录
```

## 8. 明确不做（v1 范围外）

- 媒体消息收发（图片/语音/视频/文件的 AES CDN 上传下载）
- 微信侧手动 /new /reset 命令
- 群聊（iLink bot 协议文档仅描述单聊 userId 消息，群聊未验证）
- 多微信账号（单 bot 实例）
- Web GUI 内展示二维码（v1 用终端 + 文件）
