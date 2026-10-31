# dsh-kick

与 steer 平行的「打断投递」概念：**打断当前运行，让排队的消息立即执行**。
封装为 agent 公开原语的组合：

```
agent.cancel({ kind: "user" }, { keepInbox: true })  // 打断当前回合，保留待处理工作
agent.inbox.remove(message.id)                       // 取回待处理消息
agent.steer(message)                                 // abort 后 steer 自动归 next-turn 并唤醒；
agent.followup(message)                              // 其余按 FIFO 排成后续回合
```

不改 dsh 核心；两个 harness 适配器（codex 的 `turn/interrupt`、claude 的
`control_request interrupt`）与原生 model call 中断都通过既有 abort 链路自然生效。

## 用法

排队 dock（QueueDock）每条消息的操作区、删除与 ↑ steer 之间，会出现一个
⚡ **Kick** 按钮（本地回显中、尚未入箱的行不出现）：

- 点击 → 正在运行的回合被打断（transcript 上以 aborted/user 收束，与手动
  停止同款外观），**这一条**排队消息立即作为新回合的第一条执行；其余待
  处理工作随新回合继续被认领，不搁浅。
- 会话空闲时点击 → 不打断任何东西，直接开始执行这一条（也是 cancel 后
  队列搁浅时逐条恢复的出口）。
- 消息已不在排队中（被正常认领/移除）→ 按钮提示「已不在排队中」。

不点 Kick = 现状完全不变：steer 等下一个插入点、queue 排队、停止照旧。

## 边界

- 行内按钮由客户端按 700ms 限频轮询注入（aria-label 定位 steer 按钮、
  pendingRow 排除回显行、与服务端清单按序对齐）；dsh 升级若改动这两处
  结构，按钮会静默消失（不影响其它功能）。
- compaction 等维护任务运行期间（公开 status 为 idle）不会误杀，kick 变为
  纯调度。
- jobs 通知、runtime-context 注入、工具上下文拼接（`source.kind !== "user"`）
  不在 kick 范围内。
- 等待审批 / 提问时 kick，会连审批一起打断（与「打断正在运行的东西」语义一致）。
- kick 后保留的非人工待处理工作（runtime-context 等）随新回合继续被认领，不搁浅。

## 组成

- `lib/index.js`：服务端。`GET /api/kick`（armed + 排队清单 `[{id, text}]`）、
  `POST /api/kick`（`{sessionId, itemId}` = kick 那一条；`{flush:true}` /
  `{armed}` = 编程接口；非回环部署过 connection 鉴权门，回环开放）+
  `session/event` 监听消费武装标记。
- `lib/client.js`：客户端。700ms 限频轮询增强 QueueDock 行操作区，在删除与
  steer 之间注入 ⚡ Kick（aria-label 定位 steer 按钮、pendingRow 排除回显行、
  与服务端清单按序对齐；无 MutationObserver——卡死教训见 lib 头注）。
- `test/kick.test.mjs`：离线单测（mock 插件宿主，33 例）。

## 编程接口（供其它插件使用）

本插件注册 cordis 服务 `kick`（KickService，`agent/created` 时还会给每个
agent 实例挂 `kick(message)` 方法）：

```js
// 硬依赖：inject = ["kick"]；软依赖：ctx.get("kick")?.…
ctx.get("kick").queue(sessionId)           // 排队清单 [{id, text}]（next-turn 人工消息）
ctx.get("kick").kickItem(sessionId, itemId) // kick 某一条排队消息：打断当前并立即执行
ctx.get("kick").flush(sessionId)           // kick 队列：打断当前 + 立即调度全部
                                           // 待处理人工消息。返回 {action:"flush"|"interrupt"|"none", count?}
ctx.get("kick").kick(sessionId, message)   // 打断投递一条新消息：running 先
                                           // cancel({keepInbox}) 再 steer；idle
                                           // 直接 steer 开新回合。返回是否命中 agent
agent.kick(message)                        // 等价便捷形式（持有 agent 句柄时）
ctx.get("kick").arm(sessionId, ttlMs?)     // 武装「下一条人工入箱消息」（30s TTL）
ctx.get("kick").disarm(sessionId)
ctx.get("kick").armed(sessionId)
```

`message` 用 `createUserMessage({ content, source })` 构造（dsh-llm）。

## 已知缺口（上游 feature request）

`agent.cancel(cause, {keepInbox: true})` 保留的队列本身没有调度出口——abort
路径必经 `turn()` catch rethrow，`kick()` finally 只认 `wakeRequested`，而
cancel 与普通入队都不设置它，导致 cancel 后队列搁浅、要再发一条消息才能唤醒
（见 dsh-plugins 仓库 FR「为 cancel 后保留的排队消息提供调度出口」）。本插件
的 flush 正是这条出口的手动形式：remove + steer/followup 重新投递并唤醒。
