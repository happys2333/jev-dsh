# Gate 状态

核对日期：2026-09-25（M3 local 推理本轮实测更新）。只记录本机实际执行过的命令；未执行的写 `NOT_RUN`，外部条件缺失的写 `BLOCKED`。工程 gate 通过不代表真实模型质量合格。

## M0 环境与宿主合同

| gate | 状态 | 证据 |
|---|---|---|
| compatibility | **PASS（本地运行时）** | `artifacts/compatibility.json`：真实 Cordis 上下文 + 真实 `ToolRuntime` + 生产 `AgentLoop`，只有 LLM 是脚本驱动器；7 个宿主测试全过，事件序列可用 `JEY_TRACE_FILE=<path> pnpm --filter jev-adapter-dsh test` 重放并逐字节比对 |
| 实测顺序 | 已执行 | `assemble → pre-step → llm-request → pre-execute → pre-execute-decision → guard → execute → post-execute → result → assemble → …`，R-01 在运行时成立 |
| 已证实的保护性质 | 已执行 | `pre-execute` deny 后工具体不跑；同步 guard 拒绝压过内层 waterfall 的 allow；`tools/result` 的 exec/result/content 三层全冻结、写入抛 `TypeError`；工具集只经 `PromptAssembly.tools` 投影到请求头 |
| `ask` 授予通道 | **PASS（2026-09-27 解除）** | 当初探针未组合 `dsh-user-approval`，只实测到降级。现已把真实服务装进宿主测试：授予 → 执行、拒绝 → `denied-by-host`、无人应答 → `approval-unavailable`（见 `approval.test.ts` 与 `docs/HOST_CONTRACT.md` §14）。装载时探测 `ctx.get('approval')` 的要求保留，并且现在还驱动了行为 |
| `restrict()` 时序 | **已实测（2026-09-27）** | §4 那条结论在真实 loop 上被证实：pre-step 里的 restrict 改不了本步的 assembly；同时量出更糟的一半 —— 本步被展示的工具在派发时已解析不到。见 HOST_CONTRACT §4 末与 `scoped-tools.test.ts` |
| 发行版 overlay 加载 | **PASS（2026-09-27）** | `scripts/host_boot_check.mjs`：固定版 launcher + 临时 `DSH_HOME` + `--patch` 装载构建产物，见 HOST-01 |

已核实的事实（不是声明，是查过的）：

- DSH `0.1.7-alpha.1` = 提交 `c36a83f`，npm 已发布（tag `alpha`）。
- 交接包声称的 6 个扩展点全部存在于固定提交源码：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`、`agent/pre-step`、`agent/request`、`system-prompt/assemble`。
- `tools/result` 是 `@mode emit` 且参数为 `Readonly`、返回 `undefined` → 只广播，不能改写结果。
- `systemPrompt.assemble()` 在 `agent.ts:271` 早于 `:275` 的 `agent/pre-step` → R-01 是宿主固有性质。
- `LlmCallConfig` 不含 `tools`；模型可见工具集只存在于 `PromptAssembly.tools`。
- TypeSafe/Jev 端点真实存在；SemIf 无 HTTP 服务；`buberlo/dsh-jev` 为 MIT。

## M2 DSH 插件闭环

```sh
pnpm -r build            # 0 error
pnpm -r typecheck        # 0 error
pnpm --filter jev-adapter-dsh test   # 20 测试（7 探针 + 6 闭环 + 3 cordis 入口 + 4 落盘 sink），20 pass，0 fail
```

真实 Cordis 上下文 + 真实 `ToolRuntime` + 生产 `AgentLoop`，只有 LLM 是脚本驱动器、
决策提供方是 synthetic mock。全程离线、无密钥。

| gate | 状态 | 证据 |
|---|---|---|
| host-integration | **PASS（闭环 + 装载入口）** | 6 条闭环测试：shadow 下工具体照常执行且 provider 被问一次；`off` 下 provider 调用数为 0 且不产记录；`enforce`+mock 在装载时就被 `ConfigError` 拒绝；已暂停路径仅凭确定性规则拒绝、**不产生 provider 调用**；`close()` 之后不留监听器；审计三段字段分立 |
| lifecycle | **PASS（部分）** | 装载/卸载、generation 递增、事件顺序、审计行可被 `scanJournal` 原样回读且无隔离行 |

未覆盖（不记为通过）：

- egress 拒绝路径只在 core 单测里覆盖；宿主级需要 local/typesafe 真实提供方（M3）。
- `ask` 的授予已于 2026-09-27 解除：真实 `dsh-user-approval` 组合进宿主测试，授予/拒绝/无人应答三条路径都有证据。
- `dsh` 发行入口 + `--patch` overlay 的真机启动已于 2026-09-27 跑过（固定 `0.1.7-alpha.1`，见 HOST-01）。

已补齐（原列为未覆盖）：

- `apply()` 这个 cordis 入口现在有端到端测试：真实 `ctx.plugin(jeyPlugin, config)`、不注入 provider、不注入 sink、经 `JEY_AUDIT_PATH` 落盘、落盘行可被恢复扫描器原样读回。
- `fileLineSink` 追加与轮转有 4 条单测（含"外部写入者把文件撑大后仍按磁盘真实大小轮转"）。
- 一个新确认的宿主行为：**effect 内抛错会让 `ctx.plugin()` 一起拒绝**，所以被拒的配置不可能"静默装上了但没生效"。这条已被 `enforce+mock` 与未实现提供方两条测试钉住。

**设计裁决（写清楚，因为它和"shadow 什么都不改"表面矛盾）**：确定性硬规则在 shadow
下也照常拒绝。理由是 shadow 的含义是"模型的意见只作观察"，而"这条路径已经连续失败
3 次"是已发生事实的记录，不是意见；同步 `guard()` 本来也在拒绝它，若 waterfall 在
shadow 下放过同一件事，两层就会互相矛盾。核心里 `evaluatePolicy` 的 shadow 不变量
仍然成立——它保护的是模型派生动作。

## M1 核心

命令与结果（Windows / Node v24.15.0 / pnpm 9.15.9）：

```sh
pnpm install                          # 成功，含真实 DSH 包
pnpm -r typecheck                     # 0 error（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
pnpm -r test                          # 157 + 20 + 14 + 40，全部 0 fail
pnpm --filter jev-core test:property  # 16 properties, 16 pass, 0 fail
cd python && .venv/Scripts/python.exe -m unittest discover -s tests -t .
                                      # 58 tests, OK (skipped=6)；6 条为需显式授权的真人推理测试
JEY_RUN_INFERENCE=1 ... tests.test_inference   # 6 pass（真实权重）
JEY_E2E_LOCAL=1 pnpm --filter jev-provider-local test:e2e:local  # 2 pass（真实服务 + 真实客户端）
```

| gate | 状态 | 覆盖 |
|---|---|---|
| typecheck | **PASS** | contracts + core + adapter-dsh，无 `any` 兜底，无 `@ts-ignore` |
| unit | **PASS** | 144 条：策略表 1 全 16 格与 absorbing 行、取消优先、必需题缺失、未校准不得 deny、陈旧快照、off/shadow 惰性；外发 deny 默认、精确 origin、allowlist 条件、调用方不得指定传输参数；边界校验路径收集、score 的 `expectedIndex` 是期望值（可为小数）且分布键必须是 `"0".."K-1"`；快照绑定与新鲜度；字节预算裁剪；无进展计数；固定模板与能力预检；生命周期、队列、配额账本与拒绝/归还；配置结构与矛盾组合、`config/examples/*.json` 全部过 `loadConfig` 且本地示例逐字段对着 `models.lock.json` 核；审计记录结构、隐私由字段集合而非脱敏保证、单次写者有界轮转、崩溃后撕裂末行只隔离不改写、键控摘要 |
| property | **PASS** | Jev 永不放宽宿主决定；`allow` 只可能来自 `allow`+`abstain`；shadow/off 惰性；无观测时 enforce 不 abstain；放行必经已配置 origin；裁剪后必为合法 JSON、不超预算、有记录、受保护段不被整段丢弃；暂停路径不会重获失败预算 |
| **M1** | **PASS** | `tasks.json` 要求的三件交付物齐了：`packages/contracts`、`packages/core`、`config/config.schema.json`；typecheck / unit / property 三个 gate 全绿 |
| 已实现模块 | — | `policy.ts`（§7.2）、`egress.ts`（§5.3）、`validate.ts`（§6.1）、`snapshot.ts`（§4.2/§10.1）、`truncation.ts`（§5.2）、`progress.ts`（§9）、`questions.ts`（§7.1/§8.1）、`coordinator.ts`（§4.4/§10.1/§10.2/§10.4）、`budget.ts`（§10.4 预留-归还账本）、`config.ts` + `config/config.schema.json`（§13、附录 4）、`audit.ts`（§11、§5.4、§4.1 三段分离）、`canonical.ts` |
| 本轮接线 | — | 裁剪真正进请求路径：`maxStateBytes` 在提交前生效，策略与本次调用放不下就 `INSUFFICIENT_CONTEXT` 不送问；`perTurnCalls`/`perSessionCalls` 从"配置里有"变成协调器真的执行并如实拒绝；队列按会话轮转，单会话最多排 `maxQueuePerSession` 个；审计事件新增 `truncatedPaths`，被裁掉什么必须看得见 |

## M3 提供方

```sh
pnpm --filter jev-provider-typesafe test  # 20 条契约测试, 20 pass, 0 fail（无网络、无凭据）
pnpm --filter jev-provider-local test     # 14 条客户端契约测试, 0 fail
cd python && .venv/Scripts/python.exe -m unittest discover -s tests -t .   # 58 tests, OK (skipped=6)
JEY_RUN_INFERENCE=1 .venv/Scripts/python.exe -m unittest tests.test_inference   # 6 pass，真实权重
JEY_E2E_LOCAL=1 pnpm --filter jev-provider-local test:e2e:local   # 2 pass，真实服务 + 真实 TS 客户端
```

| gate | 状态 | 说明 |
|---|---|---|
| provider-contract（typesafe） | **PASS** | 线格式逐字取自官方 API 文档（2026-09-23 检索）；出站体断言、`answers` 回镜键集断言、每个 primitive 的取值/键集/求和/一致性断言、403-vs-401、429/529 可重试、3xx 拒绝跟随、取消真的打断出站请求 |
| 隐私边界 | **PASS** | `snapshot/purpose/budget/requestId` 不出站；凭据缺失时 fetch 调用数为 0；token 不出现在任何错误文本里；审计只记别名不记 URL |
| cloud-inference | **BLOCKED** | 无 `TYPESAFE_API_KEY`、无调用预算。20 条全是对夹具与桩传输的契约测试，**不是**真实调用记录 |
| provider-contract（local） | **PASS（客户端 + 服务端）** | 客户端 14 条；服务端 `python/local_decider` 52 条协议/映射/锁测试（真实 socket、真实 `http.client`）：鉴权逐端点、字面 loopback 的 Host 校验、Origin 一律拒、413 双源（服务配置与请求预算取严格者）、411/404/405、422 题数超限、队列满 → 429 可重试、队列里耗尽预算 → 504、错误体与访问日志都不带请求内容 |
| **local-inference** | **PASS（真实权重，本机 CPU）** | `Qwen_Qwen3.5-4B-Q4_K_M.gguf` sha256 与 `python/models.lock.json` 逐项相符（`13c16f42…f8a983`，3,013,027,808 字节）；加载 12–19 s；三条固定执行门问题 2.42–2.67 s 全 answered（多次实测，最近一次见 `artifacts/local_inference_e2e.json`），同一 prompt 两次打分逐位相同；P0 那一轮改造前后三次 pYes 完全一致（0.757 / 0.673 / 0.138）；`origin=native-logits`、`calibration=uncalibrated`、`outputTokens=0`、`egress.occurred=false` |
| local-offline | **PASS（有限度）** | 服务只读本地已验证文件：`HF_HUB_OFFLINE=1` + `local_files_only=True`，缺 tokenizer 或权重不匹配即 `LOCAL_NOT_READY`，请求路径永不下载。未做断外网抓包验证，所以只声明"代码路径不取网"，不声明"严格离线" |
| 模型身份门 | **PASS（新增，缺陷 26）** | `ExpectedProvider` 在发第一个请求前逐字段比对 `provider.local.expectedModel` 与服务自报身份（`sha256:` 前缀两侧归一），不匹配即不可重试的 `UNSUPPORTED_CAPABILITY` 且提供方调用数为 0；7 条单测 + 端到端里对着 `models.lock.json` 核取值 |

真实推理下的安全性质（本轮实测，不是推导）：`conflicts-with-constraint` 的 `pYes=0.138`、
`advances-goal=0.757`、`evidence-sufficient=0.673`，经 `evaluatePolicy({mode:'enforce',
calibrationAvailable:false})` 得到 `abstain / no-jey-restriction`，宿主 `allow` 原样保留。
属性写成"未校准概率不可能产出 deny"，而不是钉死这一轮的数值。

**运维事实：`limits.deadlineMs` 默认 1500 ms 是云端提供方的量级。** CPU 上冷状态三条问题
实测 2.5 s，因此本地提供方必须显式抬高该值（schema 上限 60000），否则 enforce 下每次检查
都会以 `TIMEOUT` 失败关闭。服务端 `MAX_DEADLINE_MS` 也钉在 60000，与配置上限一致。

v1 明确**不重试**：重试只能有一层负责，协调器与提供方同时重试会让请求数相乘。代价是限流会表现为一次失败的检查，由策略层按"必需检查不可用"升级，而不是被静默吞掉。

## 2026-09-27 独立核查轮（D0 + P0）

外部核查报告 [`IMPLEMENTATION_REVIEW_20260927.md`](IMPLEMENTATION_REVIEW_20260927.md) 以 `b062941` 为基线，复现 9 项问题并指出"M0–M2 gate 已全部通过"说过头了。**9 项全部对着源码复核为真**，其中 7 项是 P0，已逐条修复；本轮起 README 不再写 gate 整体通过，逐条状态改由 [`GATE_CASES.md`](GATE_CASES.md) 承载（74 条验收案例 → 命令/具名测试/状态；当前 43 PASS、11 PARTIAL、19 NOT_RUN、1 BLOCKED）。

| 项 | 修了什么 | 钉住它的测试 |
|---|---|---|
| P0-01 重复失败暂停 | 读侧用 `key.includes(toolName)` 查 sha256/rootCallId 键；core 又把 pathKey 定成 `rootCallId ?? digest`，宿主每次调用新铸 id ⇒ 计数在真实使用里到不了阈值 | 真实 loop 跑 4 轮：body 恰好 3 次、第 4 次不执行、provider 不多付一次 |
| P0-02 会话隔离 | goal/conversation/results/position/sequence 全插件共享一份；用户输入取自 inbox 最后一条 | 两个真 agent 交错，各自 goal/session/taskVersion 正确；B 说话不推进 A 的计数 |
| P0-03 快照过期 | `snapshotFresh` 写死 true，且把捕获 ref 原样传给 `apply()` ⇒ 旧快照和自己比 | provider 挂起期间经 `ctx.waterfall` 派发真实 `agent/pre-step` ⇒ 标 stale 并给 `stale-snapshot` |
| P0-04 关键参数裁剪 | 可丢段丢光后改去"缩短受保护字符串叶子"且仍报 `ok:true`（6028B 命令被剪成 117B，尾部操作消失） | 受保护内容放不下即 `INSUFFICIENT_CONTEXT` 且不发请求；有空间时命令逐字节不变 |
| P0-05 开关/用途/上限 | `toolAssessment && … && !toolAssessment` 永假；`allowedPurposes` 只在配置阶段查非空；`maxQuestions` 与 `assertSupported` 无人调用；未实现功能接受配置后静默无效 | 关闭时 provider=0；禁止用途时 provider=0 且请求未组装；超题数发送前拒；未实现项装载即拒 |
| P0-06 校准绑定 | `calibrationAvailable = config.calibration !== undefined`，别的模型/模板/用途拟合的阈值能把未校准概率升级成 deny | 身份/模板/用途/calibrationId/calibratedPYes 逐项比对；不匹配只能 ask，匹配才允许 deny |
| P0-07 审计与内存 | 写失败只置标志位（当次仍放行）；`records` 无上限；`execution` 永远 null；公共日志直写原始 `callDigest` | 首次写失败当次 body=0；retention=1 时内存不超 1 条；新增 `execution` 行按 requestId 关联；无密钥时摘要置空、有密钥时以 `hmac:` 出现 |

同一类根因反复出现，值得单独记：**"配置里声明了"和"运行时执行了"是两件事**。本轮 7 项里有 4 项（用途白名单、题数上限、能力预检、校准适用性）属于此类，和上一轮 `expectedModel`、更早的 `perTurnCalls` 完全同形。

诊断脚本的断言方向要写清楚：`.work/audit-20260927/*.mjs` 断言的是"缺陷存在"，退出码 0 **不是**验收通过。本轮已把其中两条（重复失败、会话隔离）转成仓库里的正式回归测试；其余仍需逐条转。

D0：交接包原件 25 个文件全部按自带 `SHA256SUMS.txt` 复核通过（此前缺的 6 个已复原），bundle 自测在本机真跑过 53 条 = 51 通过 + 2 因平台不能建符号链接而跳过；`artifacts/handoff_gaps.json` 改为 history 结构，保留 09-22 的历史结论不覆盖。原件模板与本项目 schema 不兼容（12 处 UNKNOWN_FIELD），只作参考，实现侧示例在 `config/examples/` 且有测试。

## 2026-09-27 真实 launcher 核实（HOST-01 由 NOT_RUN 转 PASS）

按核查报告 P1-01 的要求补上"固定版 launcher + 临时 home/profile + 构建产物"这条链：
`scripts/host_boot_check.mjs` 在临时 `DSH_HOME` 里 `npm install @deepseek-ai/dsh@0.1.7-alpha.1`
（240 个 `@deepseek-ai` 包、519 MB，`--version` 自报 0.1.7-alpha.1），再用 `--patch` 叠加层装载
`packages/adapter-dsh/dist/src/jey-plugin.js`。**不读写 `~/.dsh`**，日志落盘前先把 `token=` 抹掉。

| 检查 | 结果 |
|---|---|
| `--dump-config` 组合出我们的条目（含构建产物绝对路径与配置块） | PASS ×3 |
| 故意坏的配置（`enforce` + `mock`）由**我们**拒绝：launcher 输出里出现 `invalid Jev configuration: ENFORCE_WITH_MOCK@/provider/kind`，且拒绝前不产生 mount 行 | PASS ×2 |
| `off` 与 `shadow` 真启动：宿主监听 + 审计里出现 mount 行（shadow 那次 journal 恰好 1 行，没有凭空多出的判定） | PASS ×3 |

同一台机器上的两个版本对同一份坏配置给出**相反**的行为，这条差异单独记（缺陷 27、HOST_CONTRACT §13）：

| launcher | 抛错的第三方条目 | 退出码 | 是否仍监听 |
|---|---|---|---|
| `0.1.7-alpha.1`（固定合同版） | `dsh: warning: 1 entry did not activate` + 原始错误 | 0 | 是 |
| `0.1.5-rc.2`（本机 `~/.dsh` 实装） | `dsh: plugin tree failed to load: failed to apply loader entry jey` | 1 | 否 |

**没做的事**：两次启动都没有驱动任何一轮模型调用，所以这组证据只覆盖"组合与装载"，
不提供判定质量结论；HOST-02 仍是 PARTIAL，HOST-04/06/08/09/10/14 不变。原始结果与两个版本的
对照写在 `artifacts/host_launcher_boot.json`。

## 2026-09-27 审批通道与执行行（HOST-06 由 BLOCKED 转 PASS）

`@deepseek-ai/dsh-user-approval@0.1.7-alpha.1` 现在是 `jev-adapter-dsh` 的直接依赖（peer 要求
`^0.1.7-alpha.1` 与 cordis `^4.0.3`，本树满足），宿主测试里真实组合它，并挂一个终端应答者：

| 路径 | 证据 | 结果 |
|---|---|---|
| 应答者授予 | `runs the call when a composed answerer grants it` | 工具体跑 1 次；执行行 `succeeded` 且 `appliedAction:'ask'` |
| 应答者拒绝 | `records a human refusal as a host denial, not as a tool failure` | 工具体 0 次；执行行 `denied-by-host` / `approval-rejected` |
| 组合了服务但无人应答 | `fails closed through the service when no answerer is composed` | 服务自己的默认 `unavailable` → `denied-by-host` / `approval-unavailable` |
| 根本没有通道 | `records the same question as a denial when no channel can surface it` | Jev 直接记 `deny` + `approval-channel-absent`，原始成因保留在同一行里 |

审批结论取自宿主持久事件对 `approval/asked` + `approval/decided`（经公开的
`ctx.on('session/event')`），不是从 `tools/result` 的错误文本猜的——那两种情况在结果层面长得一样。
把这条验证做完顺带暴露了两处"声明了但没执行"（缺陷 29、30），都已修：状态集合里
`denied-by-host` / `cancelled` / `not-dispatched` 此前没有任何代码能产出。

## 2026-09-27 只读 doctor（规格 §11）

`pnpm --filter jev-adapter-dsh run doctor -- --config … [--journal …] [--dsh-home …] [--json]`，
也可从仓库根 `node packages/adapter-dsh/src/doctor-cli.ts …`。报告的是**观测到的**配置、宿主、
提供方与审计计数，不写、不启动、不下载、不发任务状态。它存在的理由就是上一节那条发现：
launcher 在装载被拒后继续 serve，所以"配置没问题"和"Jev 在跑"必须是两句话。

本机两次真实运行：

| 对象 | 结果 |
|---|---|
| `~/.dsh`（装的 `0.1.5-rc.2`）+ `config/examples/local-enforce.json` | `NOT_READY`；`launcher MISMATCH pinned 0.1.7-alpha.1 / installed 0.1.5-rc.2`；`approval true`（读的是 dsh-base 的 patch，不是猜的）；`credential env:JEY_LOCAL_TOKEN = NOT_CONFIGURED`；探测被提供方自己拦下（无令牌不发未认证请求）；`journal-absent` |
| 固定版临时 home + 那次真启动留下的 journal | `READY`；`launcher MATCH`；`mount row mounted:mode=off provider=unconfigured egress=deny`；`inference NOT_CONFIGURED` |

8 条单测钉住的行为：配置被拒时 `REFUSED` 并带原始 code；读不到版本只能 `UNKNOWN`，不许写成兼容；
审计里没有 mount 行时即使配置合法也 `NOT_READY`；mock 永远标 `SYNTHETIC` 且不做探测；云端探测
固定 `NOT_RUN` 且断言 fetch 调用数为 0；凭据只显示已配置/未配置，断言"值不出现在
`JSON.stringify(report)` 里"。

PACK-02（版本不匹配要明确报告、不宣称兼容）因此从 NOT_RUN 变成 **PARTIAL**：命令与证据都有了，
缺的是"从安装好的 tarball 里跑它"——那要先有可安装的包（P1-04）。

## 2026-09-27 作用域、嵌套与次序边界（HOST-08/09/11/14、SEC-02、LIFE-07 转 PASS）

新增三个宿主测试文件（`scoped-tools` / `nested-calls` / `untrusted-description`），把审查里
剩下的 P0 边界逐条落到真实宿主管线上。顺带改了适配器的三处（缺陷 32、33、34），它们都是
被这些新用例逼出来的，不是先想到再写的测试。

| 案例 | 关键断言 |
|---|---|
| HOST-08 | 同名工具全局 + agent 作用域各一份：A 执行作用域定义、B 执行全局定义（body 侧记录证明），两条判定行各自对比**自己作用域被展示的目录** |
| HOST-09 | `restrict({deny:[…]})` 之后跑两个真回合：Jev 引起的 `register`/`restrict` 次数为 0（钩子本身另断言是活的），被藏起来的工具没有被"复活" |
| HOST-10 | 父 + 两个子各得一条判定行和一条执行行（`requestId` 互不相同）；三次父尝试里叶子 body 恰好跑 5 次，第 3 次的第二个子调用被 path-paused 拦下 |
| HOST-11 | 不带 agent 的调用仍然被判定并记录，作用域写作 `agentless` |
| HOST-14 | 一次判定只开一个审批问题；`APPROVAL_WITHOUT_HOST_CHANNEL` 让"要审批但宿主没通道"的配置装载失败 |
| SEC-02 | 描述与参数描述里写满改端点/换模型/放 egress/打印密钥的指令：发出体里没有这些文本、题集仍是固定模板、`runtime.config` 逐项相等、fetch 计数 0 |
| LIFE-07 | Jev 自己不制造 `tools/change`；摘要按作用域刷新，别的 agent 目录变了不把在途判定判成 stale |

**HOST-10 的边界**：桥本身没跑。`@deepseek-ai/dsh-ptc-runtime@0.1.7-alpha.2` 只发布抽象
Service 定义，锁文件里没有任何实现包，`run_code` 在这种树上进不去。用例走的是桥所用的同一个
入口（`ToolRuntime.execute` 带上父的 `rootCallId` 与 `token`），管线各阶段一致，但那是
"同一条管线的嵌套调用"，不是"PTC 桥"。所以 HOST-10 写 PARTIAL。

**HOST-14 的已知缺口**：注册在 Jev 之前的监听器如果直接返回拒绝而不往下走，Jev 根本不会被
问到——调用照样被拦（没有放宽权限），但 Jev 的日志里不会出现这条拒绝。写成了测试
（`is not consulted when a plugin mounted earlier refuses the call`），没有当成缺陷修掉，
因为在一个多插件 waterfall 里这不是我们能补的位置。

**顺带把 §8.2 的时序 gate 量完了**（原来只是读源码得出的结论）：
`shows that a restriction made inside pre-step reaches only the next assembly`。
在 `agent/pre-step` 里 `restrict({deny:[probe]})` 之后，本步的 assembly 仍然带着这个工具，
而派发时已经解析不到它 —— 工具体不跑，宿主给出一个错误结果。Jev 这条调用上正常被问到、
投了 `abstain`（宿主 `allow`），执行行却是 `failed`：一层在自己刚刚认可过的调用上遇到了
无法解释的失败。这就是"筛选只能落在 `system-prompt/assemble`"的实证理由，也是
`presentationFilter` 继续拒绝装载的原因（缺实现，不缺认知）。

## 2026-09-27 MCP 适配（mcp-contract 5 条转 PASS）

`packages/adapter-mcp` 建起来了：`schema.ts`（发布即校验的单一来源）+ `tools.ts`（快照、预算、egress、
协调器）+ `server.ts`（协议错误与工具错误分开）+ `main.ts`（stdio 入口）。文档 `docs/INSTALL_MCP.md`，
证据脚本 `scripts/mcp_stdio_transcript.mjs` → `artifacts/mcp_stdio_session.json`。测试 27 条（19 单元 +
8 契约），契约那 8 条全部 spawn 真实子进程、走真实 stdio、用官方 SDK `Client`，本地提供方是测试进程里
的真实 HTTP 监听；没有假传输层。

| 案例 | 关键断言 |
|---|---|
| MCP-01 | initialize/list/call 三段各一条：发布的 schema 与 `src/schema.ts` 逐字相同；三个工具各调一次；`structuredContent` 与兼容文本是同一串字节；再用真实 HTTP 服务答一次，身份字段来自服务端 |
| MCP-02 | 逐行扫 stdout，每行必须是 JSON-RPC 2.0 帧；日志只去 stderr；真实 token 在两个流里都不出现；客户端关 stdin 后 exit code 0 |
| MCP-03 | 未知工具 `-32601`、缺字段 `-32602`（无 result），超预算的合法请求是 `isError` result（无 `structuredContent`） |
| MCP-04 | 一次调用塞五个伪造键 → `-32602` **且服务端收包数为 0**；正常调用到达服务，快照身份是服务端自填的 `mcp` |
| MCP-05 | 取消：服务吊住 → 客户端取消 → **服务端自己看到 socket 挂断**（deadline 设成 30 s，所以看到的不是超时）→ 第二次调用在 `maxConcurrent:1` 下仍真的到达服务。断连：在途时客户端消失，进程必须自己退掉 |

四处新断言都做了破坏验证（改坏→变红→改回）：日志改指 stdout、把协议错误改写成 `isError`、把 `additionalProperties:false` 打开、把传给协调器的 `signal` 换成永不中止的控制器。**第二轮里只有 MCP-05 一次没红**：它当时把"5 秒 deadline 到了"当成"取消生效"，把 deadline 拉到 30 s 才暴露出真正的判据（缺陷 36 修完之后它才具备区分能力）。

顺带把 mock 提供方拆成 `packages/provider-mock` 给两条适配器共用，并给它补上第一份测试（此前那个包 0 条测试，缺陷 38）。

**没做的部分照实写**：MCP 这条路没有审计 journal、没有 doctor、一个进程只有一个身份（`sessionId:'mcp'`，所以 `perSessionCalls` 是进程级的）、`typesafe` 提供方直接拒绝启动、Claude Code/OpenCode 的原生 hooks 属于后续任务。规范 §12 那句"schema 与核心契约同源生成"目前满足的是"发布的那份就是校验的那份"，类型→JSON Schema 的生成器还没有（缺陷 39）。

## 过程中发现并修掉的真实缺陷

1. **shadow 不惰性**：概率分支（conflict/goal/evidence）没有检查 mode，`shadow` 下仍会产出 `ask`/`deny`。属性测试在 1000 次随机输入下命中；此前的单元测试因为固定了 `snapshotFresh: false` 而走进提前返回、把它掩盖了。修法是把 mode 处理从各分支上移到唯一出口，使不变量成为结构性事实。
2. **校验器静默失效**：`Check` 谓词只返回布尔、不记录失败路径（重构时误删了做登记的 helper），导致 `requestId: ''`、`snapshot.turn: -1`、`catalogDigest: ''` 三种非法输入被判为合法通过。已修，并补一条“收集全部路径而非第一条”的回归测试。
3. `isJsonValue` 先把所有 `number` 判为合法、之后才检查有限性 → `NaN`/`Infinity` 可穿过 `state` 校验。已修。
4. **暂停后重获失败预算**：同一路径暂停后遇到同一指纹的失败，计数从 1 重新开始，等于允许 Agent 每轮再犯 3 次、无限循环。属性测试给出反例 `[4]` 后修掉：暂停态在同指纹下保持计数不变，指纹变化（实质进展）才解冻。
5. `buildSnapshot` 只冻结外层对象，`ref` 可被就地改写 → 应用决策时读到的可能是被改过的元组。已连 `ref` 一起冻结。
6. 传给 `fc.jsonValue` 的 `shapeDepth` 在该版本并非合法约束项，运行时被静默忽略。由 typecheck 抓到并移除。
7. **回写即失效的开关**：`"const": false` 而没有 `"default"` 时，字段缺省就是 `undefined`，`undefined !== false` 会让"关掉"读成"没关"。`features.modelRouting` 与 `audit.rawContent` 各中一次，现补 default 并加了一条 schema 自审测试。
8. **我自己写的 loopback 正则是个洞**：`^http://127\.[^/?]+$` 会放过 `http://127.evil.com/`。给这条写回归测试时才发现，已改成必须匹配 `127.x.x.x` 或 `[::1]` 字面量，并留下该反例测试。
9. **队列饥饿死锁**：入队的请求被同时计入"执行中"名额，`#pump` 的条件 `inflight < maxConcurrent` 永远不成立，排队的 run 再也不会被启动。表现是测试挂到超时。
10. **超时在非法相位上结算**：deadline 原本在 `await provider` 返回之后才判定，此时 run 已在 `observed`，而 `observed → timed_out` 不在状态表里，于是抛 `IllegalTransition` 成为未处理拒绝，调用方的 promise 永不落地。改为用 race 在 `running` 相位就结算，迟到的答案只做诊断。
11. Node 的类型剥离不支持 TypeScript 参数属性（`constructor(readonly x: T)`），一个 `Run` 构造函数就让 9 个测试文件全部加载失败。
12. **`referenceDigest` 用字符串长度判熵是错的**：一份 `{path:"a.txt"}` 的 sha256 是 71 字符的"高熵字符串"，却仍然承诺着一个一次就能猜中的内容。测试断言"hmac 前缀"时失败才暴露。改成一律要求密钥——摘要的输入有多少熵只有调用者知道，这个函数不该替它猜。
13. 自查时抓到的两处自我坑陷：`DECISION_KEYS` 被我写成 `fieldCheck({...})` 的返回值（那个函数返回的是问题列表而不是键名，会让未知字段检查整体失效）；`AuditJournal.#counters` 用只读接口类型标注后无法自增，而 `readonly` 元组让 `.includes(string)` 通不过类型检查。

14. **会话配额按 agent 键控**：`sessionKey` 原本是 `session:${sessionId}/${agentId}`，等于每个子 agent 都带一份新的会话额度，`perSessionCalls` 上限形同虚设。写账本单测时才暴露，改成只按 sessionId 键控。
15. 公平性上限一开始是我推导出来的公式（`min(maxQueue, maxConcurrent)`），结果在 `maxConcurrent = 1` 时每个会话最多只能排 1 个，轮转策略**永远观察不到差异**——测试无论如何都会绿。改成协调器的显式参数 `maxQueuePerSession`，让策略本身可测。
16. 我在截断路径的宿主测试里断言了"shadow 下工具体照常执行"，实际没执行——原因是我把参数撑宽后违反了探针工具自己的 schema，宿主在 Jev 之前就拒了。这是个无关原因造成的"假失败"，去掉该断言并写明：拒自 Jev 还是拒自宿主，看审计记录的 `reasonCodes` 就能分辨。

M3 local 服务这一轮新增（全部由真实执行暴露，不是读代码读出来的）：

17. **`parseAnswer` 要求 `expectedIndex` 是整数**，而 §1.3 的定义是 `Σ(i×p_i)`：两档 0.5/0.5 的分布期望是 0.5，整数校验把它判为非法，而 `provider-typesafe` 自己就在产出 1.05（其单测钉着这个数）。给 Python 端写映射时才撞出来。同时补上"score 分布键必须是 `"0".."K-1"`"——原先 `{low:0.5,high:0.5}` 这种用标签当键的响应也能过。
18. **`python/local_decider/service.py` 少 `__main__` 守卫**：`python -m local_decider.service` 把所有定义执行一遍就退出，**exit 0、零输出、不服务**。TS 端到端测试第一次跑才撞见（"service exited with 0"）。这类"入口静默空转"只有真跑一次才能发现。
19. **Handler 的配置根本挂不上去**：`decider/token/max_input_bytes` 只写在 server 对象上，而代码用 `self.decider` 读——类里的 `decider: Decider` 只是注解、不创建属性，任何请求都会 `AttributeError`。写第一版服务测试前改成 property。
20. `download_weights` 的输出里**验证记录被 `**plan` 同名键覆盖**，打印出来的 JSON 没有 sha256/matches。退出码仍然对（判定发生在打印之后），但"证据"被自己抹掉了。键集冲突改为命名空间嵌套。
21. `LocalScorer.load` 没设 `HF_HOME` 就调 `snapshot_download(local_files_only=True)` → 去默认用户缓存里找本仓库缓存的 tokenizer，报"未缓存"。`huggingface_hub` 在 import 时就读环境变量，所以设置必须先于任何 import。
22. **队列时间被扣两遍**：`Decider.run` 把"剩余秒数"当参数传给 `evaluate()`，而 `evaluate()` 内部又按 `deadline - (now - started)` 再减一次已耗时。绝对时刻与相对量混用；改成两端都传绝对单调时刻。
23. 两处纯粹是我打错的字：包名写成 `semi_phase1`（正确是 `semif_phase1`，4 处）；`evaluate()` 的 Python 补丁里我把 `class Job:` 连同 `__slots__` 一起替换成了重复的 `class Decider:`，靠回读文件才没留下破损源码。**同类错误的防线还是那条：改完立刻读回来看，别信工具说"成功"。**
24. `is_loopback_host` 一开始接受 `localhost` 与 `ip6-localhost`，把边界交给了解析器和 `/etc/hosts`。改成只认 `127.x.x.x` 与 `::1` 字面量，与 TS 客户端的 `isLoopbackEndpoint` 对齐。
25. `LocalOptions.requestTimeoutMs` 声明了但从未被读——一个看起来能调、实际无效的全局超时，而且和"超时只来自请求剩余预算"的设计相矛盾。删掉，不是补上。
26. **`provider.local.expectedModel` 是个纯装饰字段**：schema 要求它、`config.ts` 给它建了类型、`loadConfig` 校验它的形状，但从头到尾**没有任何一处把它和服务自报的身份对比过**。也就是说，本机跑着另一个 checkpoint（换了文件、换了量化、被人替掉），Jev 照样把任务状态发过去。写服务的时候为了对齐 `sha256:` 前缀才撞见。现在由 `ExpectedProvider` 在**发第一个请求之前**探 `capabilities()` 逐字段比对，不匹配即 `UNSUPPORTED_CAPABILITY`、不可重试、提供方调用数保持 0；探测不带任务状态，所以代价不是内容外泄。这跟早先 `perTurnCalls`"配置里有但没人执行"是同一类洞：**声明了的控制必须找到执行它的那行代码，否则它只是文档。**

27. **我们记过的"配置被拒 ⇒ 宿主起不来"在固定版 launcher 上不成立**（2026-09-27 实测，见"真实 launcher 核实"一节）。`0.1.7-alpha.1` 把抛错的第三方条目归为"未激活"，只输出一行 warning 然后照常 serve；同一份配置在 `0.1.5-rc.2` 上会中止启动。这不是 Jev 的缺陷，是宿主的装载策略，但后果落在我们头上：**一个配了 enforce 却装载被拒的部署，运行的是"没有 Jev"**，而第三方插件没有任何办法把自己的激活变成必需。
28. **"Jev 已经装载并在看"此前没有任何可核对的证据**。宿主启动期的日志 exporter 是 `levels:{default:2}`，插件 info 行被过滤；off/shadow 装载成功后什么都不写。现在装载即写一行 `diagnostic / mounted:mode=… provider=… egress=…`（不含端点、路径、凭据引用），于是"启动后审计里没有 mount 行"就是可判定的"Jev 不在"。

29. **执行状态集合里三个值没人能产出**：`ExecutionOutcome['status']` 声明了 `denied-by-host` / `cancelled` / `not-dispatched`，而适配器的映射只有 `isError ? 'failed' : 'succeeded'`，且被 Jev 拒掉的调用**根本不写执行行**。后果是"人说了不"、"工具自己崩了"、"Jev 拦下了"三种事实在日志里同形，而"没写行"既可能是拒绝也可能是被淘汰。写审批测试时才会撞上：授予和拒绝的结果都是 `isError`。现在五个状态都有产出的代码路径，并且用 sabotage 验证过（去掉会话事件关联，两条审批测试立刻变红）。
30. **`approvalChannel` 曾经只影响两条分支**：`required-check-unavailable` 与 `stale-snapshot` 会因没有通道而降级为 `deny`，三个概率分支却硬编码 `ask`。于是"没有审批服务"这件事由宿主在我们之外完成，Jev 的记录里连痕迹都没有。现在统一走 `escalate()`：能问就问，不能问就自己判 `deny` 并附 `approval-channel-absent`，原始成因保留在同一条 `reasonCodes` 里。

31. **"宿主的拒绝被读成允许"没有任何测试能发现**：单调合并在 core 里是对的，但适配器读宿主决定的那行 `fromPreTool` 在 core 之外；删掉它的 `deny` 分支，typecheck 与全部测试照绿，工具体照跑。补了 `keeps a later listener’s denial ahead of what Jev decides`（在 Jev 之后注册一个返回 `deny` 的 waterfall 监听器），并用"删掉分支→测试变红"验证它确实钉得住。

32. **shadow 在"快照过期"这条路上会拦下调用**：概率分支都经过 `evaluatePolicy` 的 mode 出口，唯独 stale 分支自己拼了 `ask`/`deny` 交给宿主，完全没看 mode——于是 shadow 模式下一次在途的状态移动就把工具体拦死了，而 shadow 的定义就是"我的判断只作观察"。这跟最早那条"shadow 不惰性"是同一个形状的复发。修成：shadow 交回宿主原本的决定，`enforce` 才升级；两条都写成了具名测试。
33. **`features.approvalRequests` 只在装载时被检查**：`contradictions()` 用它拒绝"要审批但宿主没通道"的配置，然后运行期再没人读它——关掉它的部署照样在宿主有审批服务时弹窗。现在通道 = 宿主有服务 **且** 开关打开，缺任一侧都降级为拒绝；`does not prompt when approval requests are switched off, even on a capable host` 直接数应答者被调用次数（0）。
34. **执行行按 `rootCallId` 关联，嵌套时会串**：一个根调用可以有多个子派发，它们共用同一个 root。用 root 做键时第一个子调用的结果吃掉了父的记录，父与第二个子都没有行（实测只剩 2 条，应为 3 条）。改成按 `callId` 关联"这一次派发发生了什么"，`rootCallId` 仍用于"这一次尝试计几次"——两件事本来就该有两个键。这条也是靠把改动回退再跑测试确认能被抓住的。

另记：一次用 shell 打补丁的操作有 3 处替换静默没生效却报告成功，靠 grep 复核才发现；此后同类改动一律用编辑器改并回读确认。本轮仍有一次编辑器改动把 `class Job:` 换成了错误的目标行（缺陷 23），说明"回读"这一步不能省——工具说成功只代表它做了某件事，不代表那件事是对的。本轮最严重的一次同样是编辑器造成的（缺陷 31），而且它一路穿过 typecheck 和当时的全部测试，直到把它做成一次有红有绿的实验才暴露。

MCP 这一轮新增（35–39）。共同点还是老毛病：**声明了的东西没人执行**，以及**两种不同的失败被写成同一种**。

35. **客户端走了，MCP 服务还活着**：`@modelcontextprotocol/sdk` 的 `StdioServerTransport` 只在有人调用它的 `close()` 时才摘监听器，**从不监听 stdin 的 `end`**。没有在途请求时进程会因为事件循环空了而"碰巧"退出；一旦有一条发往本地服务的请求挂着（socket + 超时计时器都在 ref 事件循环），客户端消失后进程就一直跑下去。修在 `src/main.ts`：`process.stdin.once('end')` 与 `server.onclose` 都走同一个 `shutdown()`，先 `coordinator.close()`（它会 abort 在途、关提供方）再退。`MCP-05b` 是这条的回归测试，它对旧代码会变红（实测：旧代码挂到 4 秒超时）。
36. **协调器把答题方自己声明的 `retryable` 抹平了**：`CoordinatorOutcome.failed` 只带 `code`。于是 MCP 适配器要想知道"能不能重试"只能自己按 code 猜一张表——而本地协议里 429（`QUEUE_FULL`，可重试）和 504（`TIMEOUT`，服务已经放弃计算这条）落在**同一个 code 名下不同的服务端声明**，猜出来的表必然有一边是错的：客户端会被鼓励去砸一个刚说过"这条我超时了"的服务。修法是让声明活着穿过协调器（`failed` 带上 `retryable`，抛出路径读提供方错误对象上的字段），适配器原样转发，那张本地猜表被删掉。`test/unit/tools.test.ts` 用真实 HTTP 分别拿 429/503/422/504 钉住，core 侧三条 `coordinator.test.ts` 钉住"不许无中生有"（未命名的 `PROVIDER_ERROR` 一律 `retryable:false`）。
37. **服务不可达被写成"这个模型不支持这类问题"**：`capabilities()` 的探测失败和 `assertSupported()` 的拒绝共用一个 `try`，任何一个抛错都返回 `UNSUPPORTED_CAPABILITY`、`retryable:false`。503 的部署看起来像"模型不行"，运维会去换模型而不是去起服务。拆成两段 catch，前一段保留 `LocalError` 的 code 与 retryable（`LOCAL_NOT_READY` 可重试），后一段才叫 `UNSUPPORTED_CAPABILITY`。
38. **合成提供方可以自报本地身份**：`MockProvider` 的探针只钉住 `synthetic:true`，`identity.kind` 能被覆盖成 `local`。一份合成答案于是可以带着"我是本地模型"的身份出现在审计行和 MCP 返回里——正是 §3.2 要防的伪装。现在 `kind` 与 `synthetic` 一起钉住（`resolvedModel` 仍可编排，用来演练校准匹配）。同时这个包第一次有了自己的测试（`provider-mock/test/unit/mock.test.ts`，5 条），此前它是一个**零测试的共享包**，两条适配器的 gate 都站在上面。
39. **`jey_rank` 的空候选被判成能力问题**：`candidates: []` 编译出 0 道题，`assertSupported` 用 `"no questions compiled"` 拒绝，客户端收到 `UNSUPPORTED_CAPABILITY`——可是没有任何提供方被问过。改成短路：返回 `noneApplicable:true`、`abstained:false`、`provider.resolvedModel:"not-called"`，并且明确 `abstained` 与 `noneApplicable` 不是同义词（一个是"问了、模型不答"，一个是"没东西可问"），两条分别有测试。

这些都属于“看起来通过、实际不安全”一类，记录在此以便复核。

## 阻塞项

| gate | 状态 | 缺什么 |
|---|---|---|
| cloud-inference | **BLOCKED** | 无 `TYPESAFE_API_KEY`、无调用预算。代码与 fixture 契约测试照常实现 |
| local-inference | **已解除** | 2026-09-25 授权后完成：Python 3.12.13（uv）、SemIf 固定提交 editable 安装、3.01 GB 权重按锁校验通过。真实推理见上表。取权重过程中 HF 的 xet 传输在本机走到约 11 MB 后完全停住（进程活着，六分钟内零进展），杀掉后设 `HF_HUB_DISABLE_XET=1` 走经典 HTTP 达到 ~3 MB/s、十来分钟完成并验过 sha256——`download_weights.py` 里那行 setdefault 就是为这个，不是风格选择。第一次尝试留下的 `.incomplete` 仍躺在缓存里，不影响正确性 |
| `ask` 授予通道 | **已解除（2026-09-27）** | 把 `@deepseek-ai/dsh-user-approval@0.1.7-alpha.1` 作为直接依赖装进宿主测试，授予/拒绝/无人应答三条路径各有一条具名测试；`unavailable` 走的是服务自己的 fail-closed 默认 |
| `presentationFilter`（硬筛选的实现） | **NOT_IMPLEMENTED** | 时序 gate 本身已在 2026-09-27 实测清楚（restrict 落在 pre-step 晚了一步，见 §4）；缺的是把筛选写进 `system-prompt/assemble`，配置目前直接拒绝启用 |
| 宿主级 egress 拒绝（真实提供方） | **NOT_RUN** | 现在具备条件：local 服务可以真跑，M5 补 |
| MCP 侧的审计 journal | **NOT_IMPLEMENTED** | 规范 §12 没给 MCP 规定 journal，所以没写；后果是"有效性证据"只在 DSH 那条路上成立，已在 `docs/INSTALL_MCP.md` 的已知边界里写明 |
| MCP schema 与 `jev-contracts` 的生成关系 | **PARTIAL** | §12 要求"与核心契约同源生成"。现在是手写的单一来源（发布的就是校验的，有测试），类型→JSON Schema 的生成器缺 |
| 评测（M6）、最终报告（M8） | **NOT_STARTED** | — |
| secret-scan / pack-install / CI | **NOT_RUN** | M5/M7 |
| 上传 | 授权范围：可 push 到 feature 分支，**不可** push `main`、不可 publish npm、不可向第三方仓库发 PR |
