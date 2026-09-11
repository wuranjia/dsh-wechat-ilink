# dsh-wechat-ilink

把微信消息接入 DeepSeek Harness（DSH）的 cordis 插件。微信用户发消息给
iLink bot，插件为该用户维护一个持久 DSH 会话（空闲 30 分钟后自动开新会话），
agent 处理完成后把最终回复发回微信。

- 协议：微信官方 iLink（智联）机器人协议，经 `@wechatbot/wechatbot` SDK
- 会话：每用户一个持久 DSH 会话，重启后自动恢复记忆
- 权限：`wechat-safe` preset（workspace-write 沙箱 + 需审批操作直接失败）
- v1 仅支持文本消息
- 要求 Node ≥ 22（SDK 硬性要求）

## 安装

从 GitHub 安装（推荐）：

**第 1 步**：允许 pnpm 构建本插件（git 依赖靠 `prepare` 脚本构建 `lib/`，
pnpm 10 默认拦截，需先放行）。编辑 `~/.dsh/profiles/web/pnpm-workspace.yaml`，
在末尾追加：

```yaml
onlyBuiltDependencies:
  - dsh-wechat-ilink
```

**第 2 步**：安装：

```sh
dsh plugin --profile web add github:wuranjia/dsh-wechat-ilink
```

或从本地源码安装（无需第 1 步，tarball 已含构建产物）：

```sh
git clone https://github.com/wuranjia/dsh-wechat-ilink.git
cd dsh-wechat-ilink
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
        # logLevel: 'info'          # SDK 自身日志级别（debug/info/warn/error/silent）
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
3. 白名单内用户发消息，agent 处理后回复到达微信；Web GUI 侧栏里可见标题为
   `WeChat <用户ID>`（用户 ID 中非 `[A-Za-z0-9_-]` 字符替换为 `_`）的会话。
   插件日志（含二维码、忽略消息提示）输出在启动 `dsh web` 的那个终端。

## 已知限制

- **v1 仅支持文本消息**：图片、语音等会收到「（v1 仅支持文本消息）」提示。
- **配对码（风控）路径**：极少数情况下微信登录会要求输入配对码
  （`need_verifycode`）。SDK 的 `onVerifyCode` 未被插件覆盖，回退到服务端
  控制台的 stdin 提示——只有当 `dsh web` 在前台终端运行时才能输入；否则该
  登录流程会一直挂起（重启 `dsh web` 重新扫码通常可绕过）。这是罕见路径。
- **启动失败后保持 inert**：若启动链路（如扫码登录）失败，插件只记
  `startup failed` 日志，不会重试；需重启 `dsh web` 才会再次尝试连接。
- **长任务与空闲超时**：超过 `sessionIdleTimeoutMs`（默认 30 分钟）仍在
  运行回合的 agent 不会被空闲清扫中途处置（`sweepIdle` 跳过
  `agent.status === "running"` 的条目）；该回合结束后，下一次清扫或新消息
  才会按正常节奏开新会话。注意：长回合结束后若不再发消息，会话要等下一次
  空闲清扫（每 60 秒一轮）才会被回收。

## 卸载

```sh
dsh plugin --profile web remove dsh-wechat-ilink
```

并删除 `cordis.patch.yml` 中对应条目。

## 安全须知

iLink 凭证存于 `storageDir`，可完全操控该微信账号——不要提交到任何仓库。
`wechat-safe` 让需要审批的操作直接失败（fail-closed），因为微信侧无人审批。
`allowUsers` 是唯一的访问控制门：白名单内的微信用户即获得一个 agent，
其文件读写被沙箱限制在该用户的 `workspaceRoot/<用户ID>` 子目录内。
