# dsh-harness-base

第三方扩展：把 dsh 已注册上游（llm-pi-ai 的 `providers` + DeepSeek 适配器）经 `/v1` relay 代理给外部 harness（codex、claude code），并持有 harness 注册（`registerHarness`）、会话级选择、`llm/stream` reroute 与菜单行。不是 dsh 核心模型面的一部分。

## 契约面（cordis Service `llmBase`，只增不改）

- `targets(): Promise<TargetEntry[]>` — 镜像本网关可服务的模型：路由表（settings ns `llm-pi-ai` 的 `providers` dict + DeepSeek 内置路由）∩ llm 注册表。id 为 qualified id `<provider>/<modelId>`；reasoning 元数据透传。单个 provider 失败只丢自己那组。非 passthrough 的 adapter 路由（如 harness 自身的 mirror 路由）结构性排除——消费者把 targets() 回灌注册表不会递归。
- `resolve(qualifiedId): Promise<Target>` — 解码 `<provider>/<modelId>`（provider 取第一个 `/` 前缀，modelId 可含 `/`）→ `{ provider, model, api, baseURL, headers?, credentialRef?, auth }`。`api` ∈ `openai-responses | openai-completions | anthropic-messages`（照实报告，拒绝与否是调用方的事）。未知前缀 / 未知模型抛带 message 的 `LlmError`。路由表每次调用现读 settings，热更新下一跳生效。
- `localEndpoint(): { baseUrl, token? }` — 本机 relay 入口（取 webServer origin，非硬编码端口）。非 loopback 绑定时带 `token`。
- `registerHarness({ id, displayName, prompt?, icon? }): () => void` — **harness 注册 slot**。`id` 必须是调用方已注册的 llm adapter provider id；注册后该 harness 进入选择状态与菜单行，会话选中它时 `llm/stream` 被统一 reroute 回调用方的 adapter。`icon` 二选一：dsh client primitives 的图标组件名（如 `IconInspectOutlineRegular`），或完整的内联 `<svg>…</svg>` 标记（品牌 logo，自带 fill；UI 锁定渲染尺寸，`currentColor` 随主题），切换 UI 据此渲染该 harness 的 logo，缺省用默认图标。选择状态（`harness` / `harnessBySession`，volatile）与注册镜像（`harnesses` / `harnessIcons`）都存在本插件自己的 settings ns 里。

## /v1 透传语义

- 路由：`POST /v1/responses`、`POST /v1/chat/completions`、`POST /v1/messages`、`POST /v1/messages/count_tokens`；其余 /v1 路径 404，非 POST 405。relay 不感知 wire，只重写 `model`、注入凭据、拼路径。
- 路径：`/v1` 后的后缀原样拼到目标 `baseURL` 后（baseURL 是否带 `/v1` 由 provider 配置自决定）。
- body：仅改写 `model`（去 `<provider>/` 前缀，原始 modelId 下发）。无前缀 → 400（防 TUI 直连 daemon）。
- headers：剥离入站 auth（Authorization / x-api-key / cookie）与 hop-by-hop；注入目标凭据（`credentials` 服务按 `apiKeyEnv` ref 解析；协议决定形态：openai-* → `Authorization: Bearer`，anthropic-messages → `x-api-key`，deepseek-account → 活 token `x-dsh-auth-token`）+ profile 自定义 headers（最高优先，可表达 inline Authorization）。
- SSE 双向管道；客户端断连 → AbortController 掐上游；上游非 200 错误体原样回传（重试语义归调用方）。

## auth

- loopback 绑定：免 token（与本地 dsh web 使用方式一致）。
- 非 loopback 绑定：强制 token（启动时生成，经 `localEndpoint().token` 暴露），`Authorization: Bearer <token>` 或 `x-api-key: <token>`；无 token 时回落到 composition 的连接闸门（Host/Origin fence + 浏览器会话），与其他 dsh web 路由同等受控。
- **token 生命周期**：gateway 每次重激活（reload / 进程重启）重新生成 token。消费方（harness-codex）必须把 `localEndpoint().token` 纳入 spawn key —— listener 进程的 env 是固化的，token 变更时必须 respawn listener 才能拿到新值。

## 依赖

dsh-harness-codex / dsh-harness-claude 通过 cordis `inject: ["llmBase"]` 硬依赖本插件：**未安装本插件时它们整体不激活**，inject 失败信息会指向缺失的 `llmBase` 服务——先装本插件（`dsh plugin add link:<本目录> --profile <name>`）。

## 离线自检

`node test/smoke.test.mjs`（临时把插件目录的 node_modules 链到 dsh 安装内的 `@deepseek-ai/*`，直接对真实 dsh 包跑 mock 冒烟，退出时清理）。
