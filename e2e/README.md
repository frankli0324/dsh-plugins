# e2e

harness 插件的端到端与版本兼容测试。

## run-e2e.mjs — 场景 e2e

真实 dsh + 真实 claude CLI,经 one-shot headless app(`dsh --profile harness-e2e-headless "<task>"`)驱动。每次运行构建隔离 `DSH_HOME`(临时目录):harness-e2e-headless profile(link 本仓库 `dsh-harness-suite`,绝对 symlink)+ 本地 mock 模型(`lib/mock-llm.mjs`,Anthropic Messages wire,规则式应答)+ 只含该 mock 的 user patch 与 credentials。不复制真实 home 的 providers/credentials——e2e 不依赖任何远程模型或凭据有效性。路由选择经 `--patch` overlay 写 `harness-base` ns 的 `harness`/`harnessBySession`,每 case 独立注入。

```sh
node e2e/run-e2e.mjs              # 全部 case,跑完销毁实例
node e2e/run-e2e.mjs --only direct-answer
node e2e/run-e2e.mjs --keep       # 保留 DSH_HOME 供排查(路径打印在每行结果里)
```

前提:`dsh`(宿主,含 dsh-headless bundle)与 `claude` CLI 在 PATH;无网络要求(模型走本地 mock)。

Case 清单(每条对应 DESIGN.md 十、的一条教训):

| case | 验证 |
|---|---|
| `direct-answer` | harness=claude 直答;claude config dir(`$DSH_HOME/harness-claude/claude-config/`)被创建,证明确实路由进 claude adapter |
| `tool-round` | bash receipt 回合经 /v1 relay 完整走通 |
| `interrupt` | 长命令进行中 SIGINT:进程 ≤90s 退出;**同会话**下一条消息立即正常回答(codex 卡死教训的 claude 版回归) |
| `harness-switch` | 同一会话 claude → dsh → claude 往返;第三程 claude transcript 增长且无新 CLI 会话目录——resume 契约(--resume 不悄悄起新会话) |

已知局限:headless 一turn一进程,中断的"下一问"跨进程经 transcript 锚点恢复,覆盖 stale-state-on-resume 一类;进程内下一步续流由单测(mock CLI)覆盖。GUI 实测(真浏览器)不在此自动化内。

## version-matrix.mjs — 版本兼容 matrix

在仓库根 node_modules 原地换 peer 版本(`npm install --no-save`),跑三个 harness 包的单测(mock CLI,无网络),结束(含崩溃路径)还原 baseline。

| 轴 | 取值 |
|---|---|
| `@deepseek-ai/dsh-llm` | 0.2.1-rc.2(peer min)· 0.2.1-rc.4(host)· 0.2.2-alpha.2(latest) |
| `@deepseek-ai/cordis` | 4.0.1 · 4.0.5(host)· 4.0.6-alpha.1(latest) |
| `@deepseek-ai/schemastery` | 3.18.1 · 3.18.5(host)· 3.18.6-alpha.1(latest) |

```sh
node e2e/version-matrix.mjs           # 全 27 cell
node e2e/version-matrix.mjs --quick   # 9 cell(角 + 心)
node e2e/version-matrix.mjs --axis dsh-llm=0.2.1-rc.2,0.2.2-alpha.2
```

报告写 `e2e/report/version-matrix.md`。需要 registry 可达(`npm view` 同源)。
