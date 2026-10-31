# dsh-harness-claude v0.3.0 重写：决策与计划

> **落地记录（2026-10-28，两次修订）**：本计划已实现（lib/index.js + client.js + bridge.mjs + test/）。与正文的差异：(1) 选择机制**未照抄**，且最终归属变为 **dsh-harness-base 统一持有**——harness-base 提供 `registerHarness({id, displayName, prompt?})` slot，持有选择状态（harness-base ns 的 `harness`/`harnessBySession`）、统一 `llm/stream` reroute、prompt section 与模型菜单行（chain slot 单席位，Harness 面板列全值域）；两个 harness 插件只注册身份，详见 `~/.agents/wiki/dsh/llm-claude.md`；(2) 中断 finish 也携带 `replayState.claudeSessionId`；(3) 新增锚点侧文件（`forAdapter` 剥 replayState 的坑）与隔离 `CLAUDE_CONFIG_DIR`（`~/.claude/settings.json` 顶层 model 压过一切 flag/env 的坑），后者必须持久（`$DSH_HOME/harness-claude/`）。

v0.2.1 能跑，但身份站错了位置：它把 claude 当成**模型供应商**（listModels 真报模型、绑 header、模型菜单可达）。重写把它改成与 dsh-harness-codex 完全对称的 **harness**。参照实现：本仓库 `packages/dsh-harness-codex`（下称 codex 版）。

## 一、身份：harness，不是模型供应商

- **listModels 不注入**。不 override `listModels`（基类本就返回 `[]`，dsh-llm/lib/index.js:1721；GUI 模型菜单是 catalog 驱动，不 advertise 就不出现），不调 `registerModelDiscovery("harness-claude", …)`。v0.2.1 的两条注入路径（override listModels spawn CLI 问 `control_request list_models`、registerModelDiscovery 喂设置页）全删。
- 设置页若以 harness-claude ns 触发 discovery 会得到 `NO_DISCOVERY` → `llm/model-discovery-rejected` 报错（dsh-llm/lib/index.js:2000）。已核实（2026-10-29）：自定义 provider 卡片接管了 ns 渲染、标准 ModelListEditor 不跑，可不注册——空 discovery 兜底已删。
- `registerAdapter(["claude"], adapter)` 保留（reroute 的落点）；`registerConfigurableProviders` 保留（设置入口）。

## 二、选择机制：照抄 codex

- volatile config：`harness`（未来会话默认）+ `harnessBySession`（per-session 覆盖），经 configForms 写入。
- `harnessFor(sessionId)`：显式 per-session > 首次 sighting 时 pin 住的默认（`pinnedHarness` Map，与 volatile 配置同寿命）。
- 路由：`ctx.on("llm/stream", …, { global: true, prepend: true })`——非 global 监听被 cordis isolate 过滤收不到事件；prepend 保证在其他包装 listener 之前 reroute。provider 已是 `"claude"` 放行（防递归）；`harnessFor(sessionId) !== "claude"` 放行；否则 `{ provider: "claude", model: "<原provider>/<原model>" }`。
- 路由发生在 stream 边界而非 agent/request：header 的 (provider, model) 属于模型选择，写进去会把每次切换变成幻影"模型变更"。
- `ctx.systemPrompt.section` 同一装配边界渲染 harness 提示，保证 prompt 与路由一致。
- `applyConfig` 对**所有 volatile 字段** `volatileValue()` 解包（codex 版在此栽过：harness/harnessBySession 漏解包 → 持有 ref 对象 → 路由永远不匹配）。

## 三、模型路由：claude 也走 llm gateway

claude 的模型调用经 gateway relay，qualified id 一路透传，模型选择恢复权威。

**spawn 侧（flag/env）**：
- `--model <provider>/<modelId>`：reroute 改写后的 qualified id 原样传入，CLI verbatim 放进请求体 `model` 字段——gateway 路由的键。
- env `ANTHROPIC_BASE_URL` = `gateway.localEndpoint().baseUrl` 的 origin（**不带 `/v1`**，claude 自己拼 `/v1/messages`）。
- env `ANTHROPIC_AUTH_TOKEN`：remote bind 用 `localEndpoint().token`；loopback token-free，给非空占位值（防 CLI 走登录）。入站 `authorization`/`x-api-key` 都在 gateway 剥离名单（gateway lib/index.js:32-43），占位凭证不漏到下游。
- env `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。

**gateway 侧扩展**（dsh-harness-gateway，独立先行）：
- `RELAYED_PATHS`（gateway lib/index.js:56）加 `/v1/messages`。relay 是 wire-agnostic 转发：只重写 `body.model`、按 route 注入 auth（anthropic-messages target 注 `x-api-key`）、`target.baseURL + "/messages"` 拼 upstream——对 DeepSeek 内置路由（`api.deepseek.com/anthropic`）正好是正确端点。
- `/v1/messages/count_tokens` 是否加入按 CLI 实测决定（失败通常优雅降级为估算）。

**硬约束**：gateway 不做协议转换。claude 只说 Anthropic wire，**选中模型的 route 必须 `api: "anthropic-messages"`**（DeepSeek 内置路由满足；pi-ai profile 看 `profile.api`）。OpenAI-wire route 收到 Anthropic body 直接 4xx——适配器把 `UNKNOWN_MODEL`/上游 4xx 原样报出，不做兜底转换。这与 codex 不同：codex 侧有显式 `wire_api="responses"` 的 relay provider。

`config.model` 只留兜底，gateway 化后空值实际无效——relay 只路由 qualified id，菜单选择是硬前提。

## 四、进程形态与生命周期（CLI 无服务形态，被迫 1:1）

- 每 dsh 会话一个 `claude -p --input-format stream-json --output-format stream-json` 进程；stdin 写输入，stdout 收行 JSON 事件。
- 保留 v0.2.1 的：`STARTUP_TIMEOUT_MS` 冷启动超时（30s）、`SESSION_IDLE_MS` 空闲 reap（600s）——codex 一个共享 listener 不需要 reap，claude 需要。reap 只杀进程，会话条目（含 claudeSessionId 锚点）保留，下一回合走 resume；删条目会丢锚点、静默起新会话（2026-10-29 session 0aa726f2 事故）。
- gateway endpoint/token 身份记在会话上：变化 → 作废存活进程，下次 respawn+resume（懒式，对齐 codex spawn-key 语义的每会话版）。
- dispose/插件重载：清会话表、杀全部子进程（reaper 兜底）。

## 五、resume 契约

**总则：resume 只发生在冷启动（reap/重启/respawn），是常态路径不是异常。严格失败，不悄悄起新会话**——claude 的对话就是会话的上下文，丢锚点后凭空续答等于让模型编上下文。

1. 锚点：`claudeSessionId`。三处捕获——`system/init`（进程启动即有，先于首回合完成）、`result`、流消息；finish chunk 进 `replayState: { claudeSessionId }` 持久化（pause finish 也带，让中断回合的锚点先落盘），dsh 重启后从 transcript 找回。
2. `lastClaudeSessionId` 回扫**所有** assistant 的 replayState——跨 harness 切换（claude→dsh→claude）也能找到锚点。不改。
3. `hasClaudeTurn` 判据必须换：v0.2.1 用 `source.provider === "claude"`（index.js:344），harness 化后 header/source 保留模型选择的 provider，永远不等于 "claude"。改成 `replayState.claudeSessionId` 存在。
4. 严格失败两条：resume 失败 fail turn；"有 claude 回合但无 id" fail turn。
5. 模型切换 / endpoint 变化的 respawn = resume 的别名（`--resume <id> --model <新qualifiedId>`），不写"起新会话"分支。
6. abort = `control_request interrupt` 写 stdin，进程存活、内存续接。
7. resume 绑定 cwd：claude transcript 按 cwd 归档，cwd 变了 `--resume` 找不到 → 走严格失败。dsh 会话 header cwd 不可变，天然成立。
8. ephemeral/title 进程 `--no-session-persistence`，不产 replayState，永不参与 resume。
9. 待验证优化（不进 v1）：claude 2.1.310 的 stream-json 控制协议若支持 `set_model` control request，中途换模型可免 respawn。

## 六、事件对齐：chunk-log + cursor（codex 版磨平的抽象）

- append-only chunk 队列 + cursor：claude 事件直接 push chunk，block index 用回合全局自增、不重排；每个工具调用后 push pause finish（终止本 dsh step，receipt 先执行）；`result` 消息 push 终态 finish（stop/aborted/error）；`stream()` = 从 cursor drain 到第一个 finish。step 间续流 drain 下一段。
- v0.2.1 的 segments/deferred-replay/orphan/pendingText 全删（codex 版同一简化把概念从 13 个降到 7 个，并修掉卡死类 bug）。
- stale-state retirement 保留 claude 版对应物：旧回合状态（缓冲 chunk）在新消息到达时退休丢弃，绝不 drain 死队列。
- claude 与 codex 的差异只在事件源形状：codex 是 item 粒度通知（item/started、item/completed），claude 是消息粒度 stream-json——assistant 消息内嵌 content blocks（text/thinking/tool_use），工具由 CLI 自己执行，tool_result 以 user 型消息回流。"什么事件开/关一个 block"的映射是重写的主要适配工作。
- `normalizeLineBreaks` 保留（claude 同为 plain-text 终端书写，软换行升级硬换行）。
- 只发最后真实用户消息：`isInjectedUserContext` 过滤 dsh 注入的 runtime-context footer；不带 dsh system prompt、不重放对话。

## 七、receipt 与工具

- claude 在 CLI 内执行自己的工具，dsh 侧 tool-call 块是展示收据，但必须注册成真 dsh 工具（dispatch 重新 resolve，未注册名抛 ToolNotFoundError）。
- `activeSessions` 认领 + `tools/execute` 拦截器按需在 agent scope 注册 stub（`bash`/`apply_patch`/… + 动态 `mcp__dsh__*`）；结果从 `receiptResults`（LRU）按 callId 取。
- disposer 懒清理保留：认领释放后 stub 不退场会永久 shadow 真 bash（codex 版生产事故），未认领会话首次 exec 逐个注销 stub，再认领时重注册。
- exposeTools 机制保留：dsh 工具经 MCP bridge（server "dsh" → `mcp__dsh__<name>`）注入 CLI，`--mcp-config` 传给 spawn；工具列表 spawn 时快照（与 codex dynamicTools 同样的 staleness 口径）。

## 八、client 端（client.js）

- 设置传输统一 `ctx.configForms`；inject `["slots", "configForms", "modelDirectories", "uiSession"]`。
- settings.section（id "claude"、order 与 codex 错开）、provider 卡片（keyed slot key = "harness-claude"）。
- apply_patch toolview：注册 keyed slot `tool.call.toolview` key `"apply_patch"` **默认 priority**——codex 已用 -1 占位，claude 是 codex 卸载后的兜底行（两行数据兼容，互渲染无差别）。两个插件同时装不撞键（不同 priority 共存）。
- Harness 菜单行：见待定项 1。

## 九、包与装配

- package.json 补齐：peerDependencies（`@deepseek-ai/dsh-llm` / `dsh-tools` / `schemastery`，对齐 codex 版本）、`dsh.client` web bundle 入口（platform web、inject、immediately）。
- cordis.patch.yml 补默认 config：`command: claude`、`permissionMode: bypassPermissions` 等。
- 服务端 inject：`["llm", "tools", "sessions", "llmGateway", "systemPrompt"]`（llmGateway 是硬依赖，无 gateway 不激活；v0.2.1 缺 llmGateway/systemPrompt）。

### 注入点清单（谁提供什么）

**服务端服务（lib/index.js 的 `inject` 导出）**：

| 注入点 | 提供插件 | 适配器用途 |
|---|---|---|
| `llm` | @deepseek-ai/dsh-llm | registerAdapter / registerConfigurableProviders / stream waterfall（不注册 modelDiscovery） |
| `tools` | @deepseek-ai/dsh-tools | receipt stub 的 scope 注册、exposeTools 执行（ctx.tools.execute） |
| `sessions` | @deepseek-ai/dsh-session | sessionCwd（header.cwd） |
| `llmGateway` | dsh-harness-gateway | localEndpoint() → ANTHROPIC_BASE_URL / AUTH_TOKEN |
| `systemPrompt` | @deepseek-ai/dsh-system-prompt | harness 提示 section |

**客户端服务（client.js 的 `inject` 导出）**——只用两个；codex 还声明了 `modelDirectories`/`uiSession` 但其客户端组件从未使用（冗余声明），claude 不带：

| 注入点 | 提供插件 |
|---|---|
| `slots` | @deepseek-ai/dsh-client-ui-renderer |
| `configForms` | @deepseek-ai/dsh-client-ui-settings |

**客户端 slot 坐标（ctx.slots.inject 注册进哪个宿主槽位）**：

| slot | 声明/渲染插件 | claude 用途 |
|---|---|---|
| `tool.call.toolview` | dsh-client-ui-tool | apply_patch 收据行（keyed slot，key "apply_patch"，默认 priority，codex 占 -1） |
| `conversation.input.model.menu` | dsh-client-ui-model-selection | Harness 菜单行（children slot，共存方式见待定项 1） |
| `settings.models.provider-card` | dsh-client-ui-settings-models | provider 卡片（key = "harness-claude"） |
| `settings.section` | dsh-client-ui-settings-general（settings 页壳） | 插件设置分区（id "claude"） |

**bundle 层（package.json `dsh.client.inject`）**：`["@deepseek-ai/dsh-client-runtime"]`——Host 客户端模块装载机制注入的运行时依赖，同 codex。

## 十、测试

形态照抄 codex：node --test + mock claude CLI（mock stream-json 进程：stdin 读 user 消息，stdout 按 scenario 吐 init/assistant/tool_use/tool_result/result 序列，记录 argv/env 到 JSONL）。

用例清单（每条对应一个已知教训）：
1. spawn argv/env 断言：`--model` qualified id、`ANTHROPIC_BASE_URL`、token 透传、`--resume` 条件出现。
2. 直答流：init → assistant text → result → finish(stop)。
3. 工具回合分段：tool_use → pause finish → 续 drain → 终态。
4. 中断：abort 发出 `control_request interrupt`；中断后下一条消息正常回答（codex 卡死教训的 claude 版回归）。
5. resume：进程死亡后下一回合带 `--resume`；"有 claude 回合无 id" fail；resume 失败 fail turn 不降级。
6. 模型切换 → respawn+resume；endpoint 变化 → 存活进程作废。
7. receipt 生命周期：认领 → stub 注册 → 释放认领 → 首次原生 exec 拿到真结果且 stub 已注销（receipt-leak 回归）。认领只在 `#driveTurn` 前取（claim-late）：turn 输入转换、spawn/resume 失败不得留下认领——泄漏的认领让 receipt stub 在切回 dsh 后继续遮蔽原生 bash（851e3948 turn 9-11 事故：原生 bash 全答 "No result found"）；dsh 循环提前关闭生成器（`.return()`）或放弃 drain 时，turn state 与认领随终态/关闭一起销毁。
8. applyConfig volatile 解包（ref 形状下 harness/harnessBySession 必须是普通值）。
9. title/one-shot：无 replayState、不 resume。
10. gateway 侧：`/v1/messages` 转发（model 重写、auth 注入、流式直通）。

端到端：隔离 dsh 实例（DSH_HOME 拷 profiles、绝对 symlink、`dsh web --port 0`）+ 真实 claude 2.1.310 走 GUI 验证直答/长命令中断/切 harness 往返。

## 十一、实现步骤

1. **gateway 扩展**：`RELAYED_PATHS` 加 `/v1/messages` + relay 测试（独立，先行）。
2. **适配器骨架**：Config、ClaudeProcess（spawn/argv/env、stdin 写、stdout 行解析、startup timeout、interrupt）、`#sessionFor`（resume 判定）、stream()（chunk-log+cursor）。
3. **路由与 harness**：global+prepend 监听、harnessFor、systemPrompt.section、applyConfig、internal/config。
4. **receipt + exposeTools MCP bridge**。
5. **client.js**：设置页、provider 卡片、Harness 行、apply_patch toolview。
6. **package.json / cordis.patch.yml** 补齐。
7. **测试** + 端到端验证。
8. **wiki 沉淀**：实现中的新结论回 `~/.agents/wiki/mew/`。

## 十二、待定项

1. **Harness 菜单共存——已定案并实现（2026-10-28）**：选择状态单一真值留在 `harness-codex` ns（`harness`/`harnessBySession`，值域 `"" | "codex" | "claude"`）；claude 服务端跨 ns 读（settingsValue 先例）、reroute/prompt section 判据只认自己的 id；客户端各自往 `conversation.input.model.menu` children slot 注入自己的行——codex 是带 pane 的 Harness 行，claude 是单条 radio 行（写同一 ns，互斥由值域封闭免费获得），且注册包在 `whileServed(["harness-codex"])` 里（该 ns 未服务时不出现死行）。双 listener 互递归由既有 `provider === 自己 id` guard 封住。
2. `/v1/messages` 已加入 `RELAYED_PATHS`（连 count_tokens 一起）；`count_tokens` 实测是否可用仍按 CLI 表现定。
3. **空 discovery 已清理（2026-10-29）**：`registerModelDiscovery("harness-claude", async () => [])` 删除。设置页 provider-card 由插件卡片接管（key = settingsNs，标准 ModelListEditor 不 mount），无人调 `discoverModels`，空 discovery 是死代码；若日后有 surface 以 harness-claude ns 触发 discovery，会得到 `NO_DISCOVERY` → `llm/model-discovery-rejected`，届时按需再补。
4. `set_model` control request 可用性（免 respawn 换模型）——仍未验证，模型切换一律 respawn+resume。
5. `claudeHome`（CLAUDE_CONFIG_DIR）设置项要不要对称 codexHome——低优先级；加了就要写清"换 home 孤儿化全部既有 transcript/resume"的警告。
