# DSH 事件发送/接收 Timeline 全周期

> 基于源码核实（`dsh-harness-codex` 适配器 + `@deepseek-ai/dsh` 全栈），以本部署的 `codex` provider 为例。
> 生成时间：2026-10-19。

## 0. 全景

```
DSH 页面(React)                    DSH 服务端                        codex app-server
────────────────                ──────────────────────────           ────────────────
① 输入框发送
  POST /api/session/prompt ──────▶ session.prompt()
                                   └▶ agent.followup/steer
                                      └▶ agent loop: turn/start → step/start
                                         └▶ llm.stream(options) ─┐
② 适配器 thread/start|resume ──────────────────────────────────▶ turn/start
③ codex 通知 (item/started, *delta, item/completed, turn/completed)
   ◀────── WebSocket(RFC6455) over 控制socket，每帧一条JSON ──────┘
④ 翻译成 DSH StreamChunk (block-start/delta/block-end/usage/finish)
⑤ agent loop: assistant/message + tool/call + tool/result 追加进事件日志
   落盘 session.v4.jsonl.zstd (扁平追加式)
⑥ 同一批事件经 ctx.on("session/event"/"agent/assistant-stream")
   ──▶ session/follow 逻辑流 ◀── WebSocket /api/remote.mux ──────  页面订阅
⑦ 页面 MutableSessionEventSource → ConversationAssembler → chatStore
   → ChatView → ChatNodeSeat → 插槽 tool.call.toolview (ShellRow/PatchRow)
```

## 1. 发送：页面 → 服务端

1. `ConversationController.send()/sendSession()`（`dsh-client-ui-conversation`）先**乐观本地回显**：`Session.beginSubmission()` 生成 `requestId=randomUUID()`，消息立即出现在输入区下方。
2. 随后 `Session.prompt()` 发起**一元 RPC**：`POST /api/session/prompt`，信封为
   `{type:"client-request", rpcId, method:"session/prompt", payload:{args:{requestId, sessionId, mode:"queue"|"steer", content:[{type:"text",text}|{type:"image",…}|{type:"file",receiptId}], clientTimeZone}}}`，应答仅 `{accepted:true}`。**发送通道本身不带流**。
3. 服务端 `dsh-api-session-controller` 的 `prompt()`：解析 agent、登记附件，构造 `user/message` 事件（`source:{kind:"user",rpcId}`，幂等于 requestId），按 mode 调 `agent.followup()`（排队）或 `agent.steer()`（插话/打断方向）。另有一条前置的 runtime-context 注入消息（文件策略/skill 目录/时间戳 footer）跟在真实消息之后。

**传输层事实**：页面与服务器之间只有 `POST /api/<ns>/<method>` 单次 RPC + 一条常驻 WebSocket `/api/remote.mux`（`dsh-api-gateway`，`ws` 库，ping/pong 心跳，丢 2 次判死）。没有 SSE、没有 JSON-RPC 2.0 信封；`eventsource-parser` 只是 `dsh-llm-deepseek` 在服务端解析上游 LLM API 用的。

## 2. 服务端把回合交给模型（agent loop → codex 适配器）

`dsh-agent-loop` 的 `ReactLoopAgent`：`turn()` 追加 `turn/start`，循环 `step()` 直到终止，最后 `turn/end {reason}`。每个 `step()`：追加 `step/start` → `request/header` → 认领收件箱里的 `user/message`（`surfaceOp:"append"`）→ `session.deriveMessages()` 得到冻结请求 → `llm.stream()`（经 `llm/stream` waterfall 分发到注册的 provider 适配器，本部署即 `cordis.patch.yml` 注入的 `harness-codex`）。

`dsh-harness-codex/lib/index.js` 的 `stream(options)` 关键行为：

- **只取最后一条"真实"用户消息**作为 turn 输入（`lastRealUserIndex` 跳过 `Current runtime context.`/`<system-reminder>`/`Time sampled…` 开头的注入消息）；DSH 的 system prompt、历史对话一概不进入 codex。
- 线程复用：优先从上一条 assistant 消息的 `source.replayState.codexThreadId`（或内存 `threads` Map）`thread/resume`；resume 失败则 `thread/start {threadSource:"dsh:<sessionId>"}` 重开，绝不回放 DSH 历史。
- `purpose:"session-title"` 走独立一次性临时线程（`#titleStream`），结果由 `dsh-session-title` 落成 `session/title` 事件。

## 3. 接收：codex 通知 → DSH StreamChunk（适配器翻译层）

适配器用 `queue + waitResolve` 把异步通知桥接到 async generator。映射关系（全部在 `lib/index.js` 的 `onNotification`）：

| codex 通知 | 动作 |
|---|---|
| `item/started` (agentMessage/plan) | 建 text 块占位（**先缓存不外发**，见 §6 折叠设计） |
| `item/started` (reasoning) | 整回合合并为**单个** reasoning 块，发 `block-start` |
| `item/started` (commandExecution/fileChange/mcpToolCall/imageView/webSearch/imageGeneration) | 发 `block-start` + `tool-call-delta`，名字用 codex 真名（`shell`/`apply_patch`/`mcp__srv__tool`/…），不注册进模型可见工具表 |
| `item/agentMessage/delta`、`item/plan/delta` | 累积到块文本（不发 delta） |
| `item/reasoning/summaryTextDelta` | 实时发 `reasoning-delta`（折叠行显示流） |
| `item/reasoning/textDelta` | 已见过 summary 则缓存 raw，item 完成时补进展开体；否则实时流 |
| `item/commandExecution/outputDelta` | 累积输出 |
| `item/completed`（工具类） | `receiptOutput()` 算出 `{content, isError, meta:{exitCode\|diffs}}` 存入 `adapter.receiptResults`；发 `block-end` |
| `thread/tokenUsage/updated` | 累积 usage |
| `turn/completed` | 补关未闭合块；**有工具调用时把文本缓存进 `pendingReplay`**，否则补发 text 块；发 `finish`（`replayState:{codexThreadId}`） |
| `item/tool/call`（服务端请求） | 动态工具：调 `ctx.tools.execute` 执行真 DSH 工具并应答 |
| 各类 approval 请求 | `approvalPolicy:never` → 一律显式 decline |
| abort 信号 | `turn/interrupt` |

## 4. Timeline 的持久化形态：扁平追加式事件日志

没有嵌套的 message→step→block 对象，落盘是一条**扁平、只追加**的事件日志（`dsh-session`，format v4）：

- 文件：`~/.dsh/sessions/<cwd 编码>/session-<id>/session.v4.jsonl.zstd`（每行一个事件 + `session.lock`）。
- 事件形如 `{type, seq(单调递增), time, data, surfaceOp?}`；turn/step 只是事件上的字段：`turn/start|end`、`step/start|end`、`assistant/message {turn,step,message,usage?,stream}`、`tool/call {turn,step,callId,name,arguments}`、`tool/result {turn,step,message,meta?}`（`sourceEventSeqs` 回链 call）。
- assistant 消息的 `source:{kind:"model", provider:"codex", model, replayState}` 携带 provider 归因与线程恢复状态；原始 chunk 流压缩成 `text-chunks` 等紧凑记录随 `assistant/message.data.stream` 存档。
- 工具结果经 `tools/execute` waterfall（`dsh-tools`）：receipt 工具按 callId 从 `receiptResults` 取回结果，`output.render` 产出 content、`presentationMeta` 快照进 `data.meta`（exitCode/diffs 由此到前端）。压缩（compaction）只改写派生视图，从不重写日志。

## 5. 接收：服务端 → 页面

同一批事件双通道推给页面：

1. **持久事件**：`session/follow` 逻辑流（在 `/api/remote.mux` 的多路复用 WS 上，帧格式 `{type:"item", streamId, value}`）。首帧 `snapshot {header, cursor, records, projections, assistantStream:{revision}}`，之后 `event {event:{type,seq,time,data}}`。
2. **致密 LLM 帧**（`assistantStream:true`）：`agent/assistant-stream` → `{type:"assistant-stream", frame:{type:"start"|"chunk"|"end", attemptId, revision, index, chunk}}`——打字机效果的来源。
3. **断线恢复**：cursor=最后已应用 seq，重连后重新拿 snapshot（不允许落后）；缺口用一元 `session/page` 回填补齐；assistant 帧靠严格递增 `revision` 续流，重连可携带 `activeAttempt` 已累积内容，流中续播。
4. 客户端折叠：chunk 帧先变成带**小数 seq** 的临时行 `assistant/live-chunk`（排在下一个持久 seq 之前），等 `step/end` 后由持久化 `assistant/message` **settle 替换**——"流式内容转正"机制。

## 6. 渲染：时间线如何在 DSH 页面上成形

数据层：`dsh-client-store`（zustand vanilla + immer + RAF 批量通知）← `MutableSessionEventSource`（绳窗 + revision 快照）← `BoundConversation`+`ConversationAssembler` 组装；发布节奏按定义合并，**每 3 个 requestAnimationFrame 刷一帧**。

组件层（`dsh-client-ui-chat`）：

- `ChatView` → `ChatNodeList` → 每个条目一个 `ChatNodeSeat`（key=`chatRenderKey(entry)`=`JSON.stringify(["node",key,groupPart])`），经 `renderSlot("conversation.chat.node")` **按节点类型分发**：`user` / `assistant-step` / `tool-call` / `turn-process` / `turn-error` …
- **Process vs Response 分组**：`latestAnswer(turn)` 只有当最后一步是"无 tool-call 块的纯文本最终 assistant 节点"时才返回它；其余（reasoning、工具步骤）折进 `turn-process` 合成节点，折叠头显示 "Thought for Xs · N tool calls"。每步内部 `ProcessGroupDefinition` 再把纯 reasoning 步骤+工具节点归为 process 组，回复步骤独立为 response 组，`AssistantMarkdown` 按 `groupPart` 过滤块。
- **工具节点三阶段**：`assistant/live-chunk`(tool-call-delta)→`preparing`；`tool/call`→`start`（`argsRaw` 流式补全，`useToolCallArgumentsPartial()` 订阅参数前缀）；`tool/result`→`result`（块 `kind:"tool-result"` 内嵌 `call{name,argsRaw}` + `content` + `meta`）。
- **插件插槽**：`ToolCall` 组件渲染 `renderSlot("tool.call.toolview", …, {entryKey: toolName, fallback: GenericToolCard})`。本插件 `lib/client.js` 注入的 `ShellRow`(key=`shell`)、`PatchRow`(key=`apply_patch`) 命中后**替换**兜底卡片，props 为 `{phase, block, toolName, cwd, home, useDisclosure, t}`，最终渲染成 `DisclosureRow`+`TerminalBlock`（ANSI 解析、16 行截断、exit code 药丸）和 `CodeBlock lang="diff"`。`ctx.slots.inject` 在槽位未声明时挂起，等 `ToolCallTree` 声明后再注册，无时序竞态。
- **崩溃隔离**：每个插槽条目包在 `SlotErrorBoundary` 里，插件组件抛错时被"废黜"（abdicate），降级到下一优先级条目（回退 `GenericToolCard`），页面不崩。
- Reasoning：`ReasoningRow` 折叠行=摘要首行+流式 shimmer（summaryTextDelta 那条流），展开=完整 raw 内容（item 完成时补齐）。

## 7. 一回合的真实事件时间线（以"调了一次 bash"为例）

```
seq↑  user/message            ← POST /api/session/prompt 落成
      turn/start · step/start · request/header
      [assistant-stream 帧: start → chunk*(reasoning-delta) …]
      assistant/message(含 reasoning 块)          ← 步骤1落定
      tool/call {name:"shell",arguments}          ← item/started→tool-call-delta
      tool/result {meta:{exitCode}}               ← receipt 执行+item/completed
      step/end
      turn/start(隐式) · step/start               ← 适配器被再次调用
      [无 codex 请求! pendingReplay 直接外发缓存文本]
      assistant/message(纯文本)                   ← 步骤2 = 最终回答
      step/end · turn/end {reason:"completed"}
```

UI 效果：步骤1 整体折进 "Thought for…" 过程组（TerminalBlock 展示命令与输出）；步骤2 因**无工具块**被 `latestAnswer` 选中，渲染为过程组之外的正式回答。这正是适配器把文本**延迟到下一步重放**（`pendingReplay`）的设计动机——否则最后一步含 tool-call 块，整段回答都会被折叠进过程组。

## 8. 一句话总结

发送是"乐观回显 + 一元 POST `/api/session/prompt`"；接收是"一条常驻 WS `/api/remote.mux` 上的 `session/follow` 流（快照+按 seq 事件+assistant-stream 致密帧，断线按 cursor/revision 续传）"；timeline 的本体是服务端扁平追加的 v4 事件日志（zstd JSONL）；页面渲染则是"事件源 → assembler → 按 RAF 批刷新的 chatStore → 按节点类型/工具名两级 keyed 插槽分发到 React 组件"，其中 process/response 分组与适配器的延迟重放共同决定了"过程折叠、答案外显"的观感。
