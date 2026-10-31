# dsh-session-drag — 会话跨工作区拖动

一个 DSH（DeepSeek Harness）插件：在 Web 侧边栏把会话行**拖到另一个工作区**
即完成迁移。

内置 UI 只支持在同一工作区内拖动排序（`insertSessionBefore` 的语义就是组内
移位）；而会话归属由 cwd 推导——工作区注册表只把 header cwd 规范化后等于
工作区 path 的会话算作成员，且官方持久化把 header 声明为 immutable，没有
"改 cwd / 搬家"的 API。本插件用受支持的接口组合出迁移，不动任何文件格式。

## 功能

| 入口 | 行为 |
| --- | --- |
| **拖放** | 会话行拖到目标工作区行上（悬停高亮）松手即迁移，落在目标组顶部；拖到目标组内的某个会话行上则按悬停的上/下半插入到该位置（插件在行上/下沿画插入线）；同组拖动仍是原生的排序行为，互不干扰 |

迁移语义（ Host 端实现，全部走官方服务接口）：

1. **守卫**：目标工作区存在且目录在位；会话已存储；`workspace/session-activity`
   waterfall 报告无任何运行中的工作（turn/job/subagent/schedule，与归档同一
   判定）；cwd 经 realpath 解析后已等于目标 path 时明确返回"无需移动"。
2. **复制**：`sessionPersistence.open(id, 'read')` 读整份事件日志，以
   `sessionPersistence.create` 建**新会话**——header 沿源（isSeeded /
   parentSession / createdAt / delegationDepth…），仅换 `id`（官方 fork 同款
   `session-<uuid>` 形态）并把 `cwd` 写成目标工作区 path；事件逐条 append
   （分片 512），flush 落盘。标题等投影由日志自然重放，无需搬运。
3. **挂载**：新会话 `attachSession` 到目标工作区（cwd 匹配，注册表校验自然
   通过，出现在目标组顶部）。落到目标组内会话行上时，客户端随后把副本按
   落点写进该组的浏览器本地手动排序（与原生组内拖动同一个视图存储
   `dsh.workspace.view.v5`；首次写入会把排序模式切为"手动"，与原生首次
   拖动一致）。
4. **归档源**：源会话进入 registry-global 归档集合（与侧边栏手动归档同一
   机制，可随时 unarchive 撤销）。

顺序上"先复制后归档"：归档前的任何失败源会话都原封不动；归档时撞上活动
竞态会回滚 detach 副本并以 409 中止。客户端在成功后立即
`sessions.refreshProjections(新id)` + `sessions.refresh()`：新会话的标题投影
按 id 补拉（否则侧边栏会显示成"未命名"直到刷新页面），随后列表整体刷新，
新会话带标题出现在目标组、原会话从原组消失，无需刷新页面。

## 安装（web profile）

```sh
# 1. 把包链接进 profile 并加入 bundle 列表
cd ~/.dsh/profiles/web
# 在 package.json 中加入：
#   "dsh": { "profile": { "bundles": [ ..., "dsh-session-drag" ] } }
#   "dependencies": { ..., "dsh-session-drag": "link:~/dsh-plugins/packages/dsh-session-drag" }
# 并在 node_modules/ 下建同名 symlink 指向包目录
ln -s ~/dsh-plugins/packages/dsh-session-drag node_modules/dsh-session-drag

# 2. 重启 dsh web 生效（运行中的进程不会为新增 bundle 热重载）
```

本 bundle 不禁用任何内置行，插入 `dsh-session-drag` 即可，排在
`@deepseek-ai/dsh-base` 之后即可（与 dsh-rename 无冲突，先后顺序无所谓）。

浏览器半边由 package.json 的 `dsh.client` 声明（`platform: web` +
`./client` 导出 + `immediately: true`）自动进入 Web 模块表，随页面加载。

## HTTP 接口

GUI 同源 fetch 调用；走 Connection 的共享 `/api` 通道注册（`ctx.connection.fetch.register`，
与官方 `dsh-session-log-export` 的下载路由同一机制），由载体统一施加信任围栏
（trusted-host / Origin）与 cookie 鉴权，未认证请求在到达插件前就被拒绝。
仅接受 POST + JSON。

| 路径 | 方法 | 入参 | 出参 |
| --- | --- | --- | --- |
| `/api/dsh-session-drag/move` | POST | `{ sessionId, workspaceId }` | `{ ok, moved, sessionId?, sourceSessionId?, workspaceId?, eventCount? }` |

错误统一 `{ ok: false, error }`，稳定码 `code`：`invalid-request` / `workspace-not-found` /
`workspace-missing-dir` / `session-not-found` / `session-active`（附
`details.activity`）/ `session-empty` / `attach-failed` / `archive-failed`。

## 设计说明

- **为什么是"复制 + 归档"而不是原地改 cwd**：官方持久化契约把 header 定为
  immutable，也没有目录搬移 API；原地改写要去动 zstd 分代日志、写锁、
  projection cache 等内部实现，版本间极易碎。本插件全部走 `sessionPersistence`
  与 `workspaceRegistry` 的公开接口，升级 DSH 不需要跟内部格式。
- **代价**：会话 id 会变（新 id 指副本）。侧边栏不展示 id，标题/历史/时间线
  全部保留；引用旧 id 的地方（如 @-reference）不迁移。子会话（subagent）
  各有自身 cwd，不随父会话移动。
- **活动守卫**：与归档共用 `workspace/session-activity` waterfall；正在跑
  turn/job/subagent/schedule 的会话拒绝移动（409 `session-active`）。
- **移动当前打开的会话**：成功后原会话转入归档，打开中的视图不会自动跳到
  副本——从目标组点开新行即可（toast 里有提示）。这是 v1 的已知取舍。
- **同组拖动零干扰**：拖放控制器挂在 document 捕获阶段，只对"另一工作区行"
  与"另一工作区组内的会话行"这两个原生 UI 无人接手（或接手了但不产生效果）
  的落点 preventDefault/接管 drop；原生的组内会话排序、工作区排序、搜索列表
  等链路原样放行。
- **落点顺序写在客户端**：组的显示顺序本就不读 Host durable `sessionIds`
  （"按更新时间"按 recency，"手动"按浏览器本地保存顺序），所以位置通过
  `uiWorkspace.view.setSessionOrder` 写进与原生组内拖动同一个视图存储；
  Host 侧 durable 顺序保持 attach 的置顶不动。`uiWorkspace.view` 是未文档化
  内部面，缺失或变化时静默降级为默认位置，迁移不受影响。

## 自检

```sh
npm test   # 离线冒烟：host 半边 mock ctx 全流程（装配/守卫/复制/挂载/归档/回滚），client 半边模块形状与拖放控制器
```

## 已知限制

- 归档的源会话 unarchive 后回到**原**工作区（cwd 未变，这是注册表的归属语义，
  不是插件的残留）。
- 空会话（0 事件）不可移动；blank 行原生就不可拖。
- 会话 id 变更：迁移后如需继续引用，请用新 id（toast/接口返回都会给出）。
- 落到会话行上的精确位置只写当前浏览器的手动排序，其他浏览器/设备不跟随
  （原生组内拖动同样如此）；pin 行不是精确锚点——渲染时 pin 整块提到组首，
  未 pin 的副本会落在 pin 块之后。
