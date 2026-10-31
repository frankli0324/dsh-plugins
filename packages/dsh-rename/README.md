# dsh-rename — 用模型重新总结并重命名对话

一个 DSH（DeepSeek Harness）插件：把**整段对话**（用户 + 助手回合、助手用过的
工具名）压缩成有预算的摘录交给模型，产出并应用会话标题。对话每推进一轮就自动
“重新总结 + 重命名”，长对话的标题不再被第一条消息带偏。

内置的 `session-title-first-prompt-llm` 只看第一条用户消息；本插件替换它，并额外
提供 `/rename` 命令随时手动触发。

## 功能

| 入口 | 行为 |
| --- | --- |
| 自动（会话第一条消息后） | 与内置行为一致的首次起标题：整段对话 digest → 模型生成 → 应用 `session/title`（`automatic: all-prompts` 可改回每条消息后重命名） |
| **compact 前**（`renameBeforeCompact`，默认开启） | `/compact` 与自动压缩开始时（`compaction/start` 标记落盘的瞬间）触发一次模型重新总结，标题在压缩结束前落盘；压缩本身不受影响 |
| `/rename`（无参数） | 让模型重新总结并重命名；**可以覆盖手动命名的标题**（内置 service 中 refresh 是唯一正式的“解锁”途径）。命令**立即返回**（Web 输入框随之清空，与 `/compact` 一致），总结在后台进行；完成后会话流里**补发一条结果节点**（「旧标题 → 新标题」），失败同样以 error 节点提示（被更新的总结取代时不发） |
| 手动命名 | Web 输入框 `/rename <标题>` 回车、或终端等直连入口 `/rename <标题>`：锁定标题并暂停自动生成（与 Web UI 重命名行为一致）；再执行无参数 `/rename` 可交还给模型 |

标题来源与所用模型会记录在会话日志（`session/title`、`session/title-llm-request`
事件），可在 session log 查看器里审计每次总结用的确切 prompt。

## 安装（web profile）

```sh
# 1. 把包链接进 profile 并加入 bundle 列表
cd ~/.dsh/profiles/web
# 在 package.json 中加入：
#   "dsh": { "profile": { "bundles": [ ..., "dsh-rename" ] } }
#   "dependencies": { ..., "dsh-rename": "link:~/dsh-plugins/packages/dsh-rename" }
pnpm install

# 2. 重启 dsh（或等待 HMR 自动重载）后生效
```

> 注意：正在运行的 dsh 实例对「新增 bundle」的热重载不一定生效（实测修改
> profile 的 package.json 与 patch 文件后，运行中的进程未自动重载）。若
> `/rename` 未出现，重启 `dsh web` 即可；重启只影响进程，会话均已持久化。

bundle 自带的 `cordis.patch.yml` 会：

- 禁用内置标题 provider 行 `session-title-llm`（标题服务全局只允许一个 provider，
  不禁用必然有一个插件启动报 "already registered"）；
- 插入 `dsh-rename` 行并写入默认配置。

因此本 bundle 必须排在 `dsh.profile.bundles` 中 `@deepseek-ai/dsh-base` 之后。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `automatic` | `first-prompt` | 消息驱动的自动节奏：`first-prompt` = 仅会话第一条消息后生成一次（不再每条消息重命名）；`all-prompts` = 每条用户消息后都重新总结。compact 前的重命名由 `renameBeforeCompact` 单独控制 |
| `renameBeforeCompact` | `true` | compact（手动 `/compact` 与自动压缩）开始时重新总结并重命名；`false` 关闭 |
| `promptStrategy` | `replay` | 总结请求的取材方式。`replay` = **重放对话自身的可缓存前缀**（system 头 + 工具 schema + 表面消息逐节点 derive，与 `dsh-compaction-basic` 同构）+ 末尾追加命名指令 → 命名请求成为主对话请求的真前缀，命中 provider 的 KV 缓存，增量成本≈指令本身，标题质量更好（真实全文而非截断摘要）；计费按整个对话 input 计（命中部分走 provider 缓存价）。`digest` = 独立摘要帧（≤`maxInputBytes`），前缀每次全新、100% miss，成本有界；适合缓存读不打折或会话极长的场景。replay 所需的会话 API 不可用时自动回退 digest |
| `provider` / `model` | 跟随会话 | 固定用于起标题的模型路由；两者必须同时提供。缺省时优先取会话最近一次主请求的实际路由（保证 replay 前缀与缓存同模型） |
| `targetWords` / `targetCjkCharacters` | `6` / `14` | 标题长度目标（非 CJK 词数 / CJK 字数） |
| `maxInputBytes` | `24000` | （仅 `digest` 策略）摘录字节预算；超出时保留头尾、中段以 note 代替，最后一条用户消息永远保留 |
| `maxTurns` | `40` | 摘录最多保留的回合数 |
| `maxCharsPerTurn` | `260` | 单回合文本截断长度（码点） |
| `maxOutputTokens` | `512` | 首试的标题输出 token 上限，**不作为正确性闸门**：触顶但已产出文本 → 直接抢救为标题（打 warn）；零文本（预算被 reasoning 吃光）→ 预算 ×4 自动重试一次（共用 `timeoutMs` deadline）；重试仍零文本才失败。推理型模型（如 GLM-5.3-Flash）会先输出思考 token，内置的 64 就是纯靠上限硬扛；标题文本最终仍由服务端 `maxTitleBytes`（默认 80 字节）截断 |
| `timeoutMs` | `60000` | 辅助调用端到端超时 |
| `showToolNames` | `true` | 摘录中是否附带助手每回合用过的工具名（如 `bash`、`str_replace_editor`） |

修改配置：编辑 profile 的 `cordis.patch.yml` 覆盖 `dsh-rename` 行，或直接改本包
`cordis.patch.yml`（HMR 会自动重载；重载时插件会先注销旧 provider 再重新注册）。

## 卸载

从 profile 的 `dsh.profile.bundles` 移除 `dsh-rename`、删除
`dependencies` 里的 link 并 `pnpm install`，内置 first-prompt 标题行为自动恢复。

## 实现说明

- 注册为 `ctx.sessionTitle` 的 provider（`automatic: all-prompts`），标题经服务的
  归一化与 revision/取消语义落盘，不做任何旁路写。
- LLM 调用与内置 `@deepseek-ai/dsh-session-title-llm` 同策略：
  `purpose: "session-title"`、`deadline` 超时熔断、`BlockAssembler` 汇编、
  `normalizeSessionTitle` 清洗（额外成对剥除模型输出的 Markdown/引号包裹）；
  每次派发前写入 `session/title-llm-request` 留痕。
- `/rename` 的模型总结不阻塞命令返回：声明了 `input` 的命令在 Web 端走
  claim submit，composer 会持有输入框草稿直到 handler settle，阻塞会让
  `/rename` 文字留存整个总结过程；立即返回 + 后台 refresh 使输入框与
  `/compact` 一致地随提交清空。总结完成后补发一对 `command/run` +
  `command/done`（已知的 log-only 事件对，聊天端按 commandId 关联渲染为
  命令流节点），回显「旧标题 → 新标题」；失败同样以 error 节点提示，被
  更新的总结取代（abort）时不发。
- 兼容性：不新增自定义会话事件类型（持久化目录只认已知事件表），digest 覆盖到的
  真人消息 seq 作为 `messageSeqs` 归因返回，严格满足服务端校验。注意
  `session/title-llm-request` 内嵌消息的 `source.kind` 必须固定为
  `"dsh-session-title-llm"`（持久化读取端 `titleSources` 硬校验；写成自定义
  kind 会导致整份会话日志在加载时被判为 corrupt——2026-10-17 已修复并回填
  10 个受影响会话）。

## 自检

```sh
npm test   # 57 项离线冒烟检查：装配 / digest 构建与字节预算 / 标题清洗（真实输出形态）/ 失败翻译 / 命令路径 / compact 钩子 / 配置校验
```

## 已验证的行为（2026-10-16，隔离 DSH_HOME + web profile 实测）

1. 首条消息后：先落 fallback 标题，随后模型标题以 `source: {kind: "provider",
   provider: "dsh-rename"}` 事件覆盖，侧边栏实时更新；之后的用户消息**不再触发
   自动重命名**（`first-prompt` 节奏，实测第二条消息后标题保持不变）。
2. **compact 前重命名**：`/compact` 触发的 `compaction/start` 落盘后 2ms 内钩子
   派发总结请求，模型新标题在 `compaction/end` 之前落盘（实测：两轮 Redis 持久化
   对话 compact 后标题更新为「Redis 持久化机制详解：RDB 与 AOF 的优缺点对比及
   混合持久化」，压缩本身正常完成 6 条历史压缩）。
3. `/rename`（无参数）：命令立即返回、输入框清空，模型总结后台进行；完成后会话流补发一条「旧标题 → 新标题」结果节点并解锁手动命名。
4. `/rename <文字>`（终端等直连入口；Web 端用侧边栏重命名，语义相同）：手动命名并锁定；后续新消息不再自动重命名（服务端 pin 语义）。
5. 手动锁定后再次无参数 `/rename`：模型基于全量对话重新总结并覆盖手动标题。
6. 标题清洗：`**标题：** xxx**`、`### 标题`、“标题如下：”前导行、未闭合 `**`、
   尾随说明段等真实输出形态均清洗为干净单行标题（服务端 `maxTitleBytes` 截断）。
