# dsh-harness-base 设计定稿（2026-10-27）

> **更名（2026-10-28）**：插件 `dsh-harness-gateway` → `dsh-harness-base`，服务 `llmGateway` → `llmBase`，入口 id `harness-gateway` → `harness-base`。本文按历史名称记录，现名对照上文。

OpenAI 兼容 relay 网关插件，作为 dsh-harness-codex 的依赖插件。dsh 对协议不感知、只负责转发；gateway 独立插件、harness-codex 依赖之。

**harness 切换已整体移除（2026-10-27 晚）**：harness-codex 的 `config.harness` 字段、`llm/stream` 拦截、Harness 选择面板全部删除。dsh 侧不存在 harness 切换面；会话绑定只有模型选择器的 `(provider, model)`。gateway 保留为透传层，供以 qualified id `<provider>/<model>` 直呼 codex provider 的调用方使用。

## 架构

```
选择面   模型选择器（原样）→ 真实 provider/model
控制面   dsh-harness-codex ──app-server RPC──▶ codex        （现状保留，不动）
模型面   codex ──POST /v1/responses|/v1/chat/completions──▶ dsh web gateway
              ──同后缀透传──▶ <源provider>.baseURL + credential
```

模型面从「codex wrapper 直连各 provider」收回 dsh：dsh 的 Models 页成为 harness 模型的唯一真相，切 provider 下一跳即生效；消灭 per-provider wrapper 动物园、auth token 轮换、provider catalog 快照类问题。

## 插件职责边界

**dsh-harness-gateway（本插件，无任何 harness 概念，禁止 import/call harness-codex）**

- `ctx.webServer.register({kind:"prefix", path:"/v1"})` 上挂 `POST /v1/responses`、`POST /v1/chat/completions`，纯透传。
- 注册 cordis Service `"llmGateway"`，契约面（只增不改）：
  - `targets(): Promise<TargetEntry[]>` —— 镜像 dsh 当前已配置模型。实现：`ctx.llm.listProviders()` 排除自身相关路由 → 逐个 `listModels(provider)` + `resolveModelInfo(provider, model)`，产出 `{ id: "<provider>/<modelId>", name, provider, modelId, description?, reasoning? }`（id 编码规则见下）。
  - `resolve(qualifiedId): Promise<Target>` —— 解码 `<provider>/<modelId>` → 从路由表取 `{ provider, model, api, baseURL, headers, credentialRef }`。`api` ∈ `openai-responses | openai-completions | anthropic-messages`（pi-ai 协议词表）。未知前缀/未知模型 → 抛带明确 message 的错误。
  - `localEndpoint(): { baseUrl, token? }` —— 本机 relay 入口（取 `ctx.webServer` 的 listenedPort/root，不硬编码 3080）；非 loopback 绑定时带 token。
- 路由表来源：settings ns `llm-pi-ai` 的 `providers: { <routeId>: { baseURL, api, apiKeyEnv(credential-ref), headers, models[] } }`（0.2.1-rc.2 schema 已确认）；deepseek 内置路由（`deepseek-account` / `deepseek-official`）固定端点。请求时读取，settings 热更新即时生效。
- 透传语义：
  - 路径：`/v1/` 后的后缀原样拼到目标 `baseURL` 后（与 codex 对 base_url 的拼接语义一致；baseURL 是否带 `/v1` 由 provider 配置自决定）。
  - body：仅改 `model`（去 `<provider>/` 前缀，原始 modelId 下发）。
  - headers：剥离入站 auth，注入目标 credential（credentials 服务按 `apiKeyEnv` ref 解析）+ profile 自定义 headers；其余（originator 等）原样保留——seed 路由对 originator 头敏感，透传保真是选型理由。
  - SSE 双向管道；客户端断连 → AbortController 掐上游；上游非 200 错误体原样回传（重试语义归 codex 的 stream_max_retries）。
  - body.model 无前缀 → 400 明确报错（防 TUI 直连同一 daemon 误入）。
- auth：绑 loopback 时不要求 token、不挂闸门（本机 curl/codex 免配置；实测 dsh web 其他路由的 `requestRejection` 在 loopback 也 401 无 cookie 请求，挂上会破坏本地免配置使用）。绑非 loopback 时强制 token（apply 时生成，经 `localEndpoint().token` 暴露，spawn harness 时注入伪 provider 的 `env_key`），`Authorization: Bearer` / `x-api-key` 皆可；无 token 时回落 webserver 现成的请求拒绝闸门（`connectionOf(ctx).requestRejection(req)`，参照 dsh-host-open-in-app 用法）——浏览器会话放行、其余 401/403。token 在 gateway 重激活时重新生成：消费方须把 `localEndpoint().token` 纳入 spawn key，token 变更自动 respawn listener（listener 固化 env 会持旧 token）。
- 每请求一行日志（model、目标 provider、耗时）；不做计量改写。

**dsh-harness-codex（依赖方，本仓库 packages/dsh-harness-codex）**

- `inject` 增加 `"llmGateway"`（cordis 硬依赖：gateway 缺失则本插件不启动）。
- `listModels` 返回空（codex provider 不在模型选择器广告条目）；`resolveModel(codex, "<src>/<id>")` 转调源 provider 的 resolveModelInfo 透传 reasoning efforts。
- `#thread()`：只传 qualified id 的 `model`，**不传 `modelProvider`**——adapter spawn listener 时以参数 `-c openai_base_url=<relay>` 把 codex 内置默认 provider（openai）的 base_url 指向 relay，路由即此一处（见「路由定稿」）。
- **harness 是会话维度开关**（2026-10-28；2026-10-30 改为 session log 存储，同日清理旧存储逻辑）：每会话选择的**事实源是 session log 里的 `plugin:harness/selection` 记录**（appendPluginRecord，ignorable，fork 随行），由 "harness" 投影折叠、`sessionProjections.stateOf(session, "harness")` 读取——重启/插件重载后从日志懒重放，fork 携带。`harnessBySession`（volatile dict）是**纯切换传输**：只由客户端菜单行写入，`internal/config` 监听把变化转换成记录；host 不再写它。`harnessFor` 读序：投影记录 → dict（切换落记录前的窗口）→ 内存 pin。`harness` 字段仍为默认值且随每次切换更新（语义同 agent-default-model）；**首次使用**（首个会话事件，对齐模型选择"首个 request/header 锁定"的时机）把当时默认 pin 成记录，此后默认变化不再触达，从未运行过的会话读 live default。未注册 id 一律不落记录（recordHarness 校验 `base.harnesses.has`，native "" 除外；客户端菜单保存前同样拒绝）——与 selectModel 的 requireModel 同一 fail-loud 契约。菜单行当前值改读投影 face（`projections.faceOf("harness")`），dict 只作 face 未落地时的回落。`@deepseek-ai/dsh-session` 以 `file:` link 指向运行中 dsh 的那份拷贝——appendPluginRecord 走私有方法 brand 校验，两份拷贝会全部拒绝。
- **存量迁移**（2026-10-30）：启动时若 `harnessBySessionMigrated` 为 false，遍历 dict 条目，经 `sessionPersistence.open(id, "write")` 短租约把每条写入对应会话日志（读尾部查重 → append → flush → close），完成后置 flag 关闭扫描。存活会话跳过（materialize 路径自会写）；**空日志会话跳过**（从未运行，不持有旧默认）；日志尾部记录已一致的跳过；NotFound/writer-held 等 warn 跳过，留待下次打开时懒迁移。迁移不做注册校验——忠实拷贝存量。
- 控制面全部保留：CodexAppServer、通知→chunk 翻译、split-turn 状态机、receipt 桩、apply-patch diff 卡。
- gateway 的 baseUrl/端口纳入 `applyConfig` 的 spawn key：端口变更自动 respawn listener。

**（已废止的 wrapper 契约）** 此前的方案让 wrapper 识别 `DSH_PROXY_*` env 并注入 `dsh-responses` 伪 provider——按「从一开始就不要用独立的 model provider」作废，gateway relay 的指向改为 spawn 传参 `-c openai_base_url`，wrapper 零改动。以下仅存档当时形态：

- 识别 env `DSH_PROXY_BASE_URL` / `DSH_PROXY_TOKEN`（适配器 spawn listener 时经 env 传入）→ 注入一条静态伪 provider：
  ```toml
  [model_providers.dsh-responses]
  name = "dsh-responses"
  base_url = "<DSH_PROXY_BASE_URL>"     # 形如 http://127.0.0.1:3080/v1
  wire_api = "responses"
  env_key = "DSH_PROXY_TOKEN"           # loopback 部署可缺省
  ```
- 遵守既有共享 listener 契约三段式（`app-server` + `CODEX_APP_SERVER_SOCKET` → `--listen unix://<path>`；listener 模式禁追加子命令级 `-c`）。

**路由定稿（2026-10-27 深夜修订：只做最简单的路由，无协议判断）**

codex-cli 0.163.0 只会发出 responses wire 的请求（chat wire 已移除，openai/codex #7782），wrapper 只注入 `dsh-responses` 一个伪 provider 指向 gateway relay。路由就是固定一跳：

- `thread/start` 只传 qualified id 的 `model`，**不传 `modelProvider`**；listener 的 spawn 参数带 `-c openai_base_url=<relay>`——只改内置 openai provider 的 base_url，provider 的其余字段（wire_api 默认 responses、无自带 auth）全部保持 codex 原样。**不做任何协议判断**——`gateway.resolve()` 的 `api` 只是元数据，harness/gateway 都不据此拒绝。
- gateway 原样转发 responses 请求体到目标 baseURL；目标端点认不认这条 wire 是 provider 自己的事，上游的错误（含 404）原样回传给 codex——透明失败优于预先拒绝。
- 修订记录：此前版本曾按 `resolve(id).api` 对 completions/anthropic 目标早失败（「选项 A」），与「dsh 对协议不感知、纯转发」的定稿相悖，已删除。

## 选择面语义（2026-10-27 修正；切换面已于当日移除）

harness 切换（独立选择页面 + `llm/stream` waterfall 拦截 + settings ns `harness-codex` 的 `harness` 字段）在 2026-10-27 晚整体移除，本节仅存档当日结论：模型选择器绝不出现 harness；会话绑定 = 真实 `(provider, model)`；harness 维度若日后恢复，属于 dsh 本身的扩展（`ctx.harness` 注册 + 会话维度绑定 + agent loop 路由 + 独立页面），不是插件在模型选择器里伪装 provider。当前无任何 harness 路由：以 qualified id 直呼 codex provider 的调用经 gateway 透传。

## 拆分理由与代价

- 故障半径：reload gateway 只摘 `/v1` 路由，控制面连接与 codex 会话状态无损，模型请求由 codex stream 重试接住（单插件方案会连控制面一起拆）。
- 契约升级解耦：版本契约是 `llmGateway` 服务 JS 表面，只增不改；harness-codex 对 gateway 用宽 range `dependencies`（非 peer；compat 预检不查 `dsh-*`，精确 pin 只有拒载风险）。
- 代价：两个发布单元、profile 需插入 gateway entry；硬依赖下未装 gateway 则 harness-codex 整体不激活（刻意选择，报错要可读）。

## 实施切片

1. gateway 骨架：Service + `/v1` 路由 + 固定单目标（settings ns `harness-gateway` 可配）透传跑通；harness-codex 接 inject。
2. `targets()/resolve()` + 镜像目录 + qualified id codec（codec 归 gateway——解析方拥有格式）。
3. 伪 provider 双 wire_api 切换、`api` 预检、非 loopback token、wrapper 契约增量。
4. 收尾：端口变更 respawn、请求日志、wiki 沉淀（gateway 服务契约 + wrapper 增量段）。

## 关键参照（dsh 0.2.1-rc.2，~/.local/lib/node_modules/@deepseek-ai/dsh/）

- webserver：`node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js`（register/listenedPort/isLoopbackHost）。
- 路由 + 鉴权闸门示例：`dsh-host-open-in-app/lib/index.js:1271`。
- LLM 注册表：`dsh-llm/lib/index.js`（listProviders/listModels/resolveModelInfo/registerAdapter；call-config 含 provider+model）。
- pi-ai profile schema：`dsh-llm-pi-ai/lib/index.js:1049`；settings ns `llm-pi-ai`。
- 模型目录聚合参照：`dsh-api-session-controller/lib/types/catalog.js`（buildModelCatalog）。
- 插件 manifest/打包参照：本仓库 `packages/dsh-harness-codex/package.json`（dsh.bundle.patch / dsh.client 注入）、`cordis.patch.yml`。
- 插件兼容预检规则：`~/.agents/wiki/dsh/plugin-compatibility.md`（peer 用 `^0.2.1-rc.2` range）。
- 运行中的 dsh web：http://127.0.0.1:3080（**重启需用户批准**，代码改动走 HMR）。
