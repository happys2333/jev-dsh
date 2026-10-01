# 验收案例 → 实现侧状态

核对日期：2026-09-27。代码基线见文末。这张表把交接包 `contracts/test-matrix.csv` 的 74 条案例映射到**本仓库实际执行过的命令与测试名**。

规则：
- 原件 `docs/handoff/**` 是需求与验收材料，**不改动**；它的 `status` 列全是 `NOT_RUN` 是计划初值，不代表现状,也不被本表覆盖。
- 本表只认执行证据。`PASS` 必须能指到一个具名测试或一次真实运行；相近但不等价的工作写 `PARTIAL` 并说清差在哪。
- 工程 gate 通过不等于模型质量合格（`semantic-eval`/`system-eval` 整组未开始）。

## host-integration（14）

命令：`pnpm --filter jev-adapter-dsh test`（真实 Cordis 上下文 + 真实 `ToolRuntime` + 生产 `AgentLoop`，只有规划 LLM 是脚本驱动器）；HOST-01 另跑 `node scripts/host_boot_check.mjs --dsh 0.1.7-alpha.1 --home <临时 home>`（真实发行版 launcher + 构建产物）

| 案例 | 状态 | 证据 / 差在哪 |
|---|---|---|
| HOST-01 真实 Launcher 加载 | **PASS** | `scripts/host_boot_check.mjs`：临时 `DSH_HOME` + `@deepseek-ai/dsh@0.1.7-alpha.1` 真实 launcher + `--patch` 装载**构建产物**。8 条检查全过（`--dump-config` 组合出我们的条目、`enforce+mock` 由我们的 `ConfigError` 拒绝且拒绝前不写 mount 行、`off`/`shadow` 真启动且审计出现 mount 行）。证据 `artifacts/host_launcher_boot.json`。注意同版本下"装载被拒只 warning 后继续 serve"，见 `docs/HOST_CONTRACT.md` §13 |
| HOST-02 真实原生调用 | **PARTIAL** | 事件顺序在真实 loop 上可追踪（`ordering.test.ts`），但模型是脚本、工具是探针，缺真模型驱动的一轮 |
| HOST-03 组装时序 | **PASS** | `observes assemble -> pre-step -> pre-execute -> execute -> result on the real runtime`、`advertises exactly the assembled tool set to the model` |
| HOST-04 最终输入改写 | **NOT_RUN** | `presentationFilter` 直接拒绝装载（`FEATURE_NOT_IMPLEMENTED`），未实现。它卡的那道时序 gate 已于 2026-09-27 实测清楚：pre-step 里的 `restrict()` 对本步 assembly 无效，而且会让本步展示过的工具在派发时解析不到（`scoped-tools.test.ts`），所以筛选只能落在 `system-prompt/assemble` |
| HOST-05 宿主拒绝保持 | **PASS** | `lets a monotonic guard denial outrank a waterfall allow`、`stops the tool body when a tools/pre-execute listener denies the call`、`keeps a later listener’s denial ahead of what Jev decides`（适配器读宿主决定的那一环，2026-09-27 补：删掉 `fromPreTool` 的 deny 分支时它会变红），加上属性 `Jev can never loosen the host decision` |
| HOST-06 宿主审批保持 | **PASS** | `approval.test.ts` 组合真实的 `@deepseek-ai/dsh-user-approval`：`runs the call when a composed answerer grants it`（授予才执行，execution 行 `succeeded`+`appliedAction:'ask'`）、`records a human refusal as a host denial…`（拒绝 → `denied-by-host`/`approval-rejected`，body 0 次）、`fails closed through the service when no answerer is composed`（无人应答 → `approval-unavailable`，仍不执行）。审批结论取自宿主自己的 `approval/asked`+`approval/decided` 会话事件对，不是从结果文本猜的。边界：应答者是测试里注册的合成监听器，"人在浏览器里点按钮"没跑过 |
| HOST-07 无审批服务 | **PASS** | `records the same question as a denial when no channel can surface it`（Jev 自己把无法弹出的 `ask` 记成 `deny` + `approval-channel-absent`，行里保留原始成因）；另有探针级 `degrades an ask decision to a denial because no approval service is composed` |
| HOST-08 作用域同名工具 | **PASS** | `scoped-tools.test.ts`：`judges a same-name tool by the definition its own scope executes`。全局与 agent 作用域各注册一个同名不同参的 `dup`，A 跑到作用域定义、B 跑到全局定义（body 记录证明），两条判定行的 `catalogDigest` 各自等于**自己那个 agent 被展示的目录**（装载器改为按作用域记摘要，见缺陷 34/§15） |
| HOST-09 已有可见性约束 | **PASS** | `leaves a hidden tool hidden: Jev registers nothing and restricts nothing`。`agent.ctx.tools.restrict({deny:[…]})` 之后：A 看不见、B 仍看得见；对 `register`/`restrict` 挂钩计数，跑两个真回合后 Jev 引起的变更次数仍是 0（并且断言钩子本身是活的，否则"0"没有意义）；隐藏的工具在整个回合后仍然隐藏 |
| HOST-10 嵌套工具传输 | **PARTIAL** | `nested-calls.test.ts` 三条：父+两子各得一条判定与一条执行行（`requestId` 互不相同）、同一 attempt 的两个相同子调用只计一次失败（3 次父尝试 → 叶子 body 恰好 5 次，第 3 次的第二个子调用被 path-paused 拦住）、子调用不会因为嵌套而被跳过。**边界**：走的是 PTC 桥所用的同一个入口（`ToolRuntime.execute` + 父的 `rootCallId`/`token`），不是桥本身——装的 `dsh-ptc-runtime@0.1.7-alpha.2` 只有抽象 Service 定义，锁文件里没有 node 实现，`run_code` 起不来 |
| HOST-11 无 agent 的受保护调用 | **PASS** | `still checks an agentless call instead of skipping it for want of a session`：`ctx.tools.execute` 不带 agent 时仍走判定、仍写行，`sessionId` 记为 `agentless`，shadow 下不额外限制 |
| HOST-12 热替换后恢复 | **PARTIAL** | generation 递增 + `stops observing once the plugin instance is disposed`；未测真实 HMR 重装 |
| HOST-13 异常最终结果 | **PASS** | `gives tools/result observers a frozen outcome and no return channel`，且新增 execution 行记录 `failed` |
| HOST-14 插件次序组合 | **PASS** | 三个方向都有用例：内层监听器 allow 时 Jev 的 ask 原样送达（`approval.test.ts` 授予/拒绝/无人应答）；`opens exactly one approval question per decision` 证明一次判定只开一个审批问题；`APPROVAL_WITHOUT_HOST_CHANNEL` 让"声明要审批但宿主没有通道"的配置直接装载失败。**已知边界**：`is not consulted when a plugin mounted earlier refuses the call` —— 注册在 Jev 之前的监听器直接短路时，调用仍被拦（权限没有被放宽），但 Jev 无从记录这条拒绝 |

## property（6）

命令：`pnpm --filter jev-core test:property`（16 条，全绿）

| 案例 | 状态 | 证据 |
|---|---|---|
| POL-01 动作合并全表 | **PASS** | `Jev can never loosen the host decision` + 16 格全表单测 |
| POL-02 重复合并幂等 | **PARTIAL** | 全表覆盖 + `an allow outcome requires an allow host`；"合并两次等于合并一次"没写成独立属性 |
| POL-03 硬规则不依赖模型 | **PASS** | `under enforce a hard rule denies whatever the model said`、`off and shadow never restrict, whatever the inputs` |
| POL-04 必需问题缺失 | **PASS** | `with no usable observations, enforce never abstains` |
| POL-05 快照过期 | **PASS** | 属性 + 宿主级 `will not apply a decision whose snapshot moved while the provider was thinking` |
| POL-06 预算并发预留 | **PASS** | `a path cannot pause before the configured identical-failure limit`、`暂停路径不会重获失败预算`（账本单测在 `budget` / `coordinator`） |

裁剪相关的 4 条属性（`accepted payload never exceeds the budget`、`rejection only with INSUFFICIENT_CONTEXT`、`hard policy and this call are never dropped wholesale`、`anything removed is reported`）属于 SEC-04。

## provider-contract（10）

命令：`pnpm --filter jev-provider-typesafe test`（20）、`pnpm --filter jev-provider-local test`（14）

| 案例 | 状态 | 证据 / 差在哪 |
|---|---|---|
| WIRE-01 逐题身份校验 | **PASS** | 每个 primitive 的取值/键集/求和/一致性断言；`requestId`、快照身份回镜 |
| WIRE-02 概率边界 | **PASS** | 越界与 NaN 拒绝（core `validate` + 提供方） |
| WIRE-03 Noul 语义 | **PASS** | noul 无 confidence 字段，不补造 |
| WIRE-04 Score 语义 | **PASS** | 键必须是 `"0".."K-1"`，`expectedIndex=Σ(i×p_i)` 允许小数（本轮修正） |
| WIRE-05 认证错误 | **PASS** | 缺 token 走 403，文档写 401 的偏差已记录并按实际处理 |
| WIRE-06 限流退避 | **PARTIAL** | 429/529 标为可重试，但 v1 明确**单层不重试**；退避由调用方/宿主决定，本仓库不实现 |
| WIRE-07 跨域重定向 | **PASS** | 3xx 一律拒绝跟随 |
| WIRE-08 超大响应 | **PARTIAL** | 请求侧字节预算与响应结构校验都有；"响应体字节上限"依赖 HTTP 层，没有单独断言 |
| WIRE-09 部分失败 | **PASS** | `status=ok/partial/failed` 由逐题结果决定，策略不能只看整批 |
| WIRE-10 显式 Mock | **PASS** | `synthetic: true` 恒真且不可被配置覆盖；`enforce`+mock 装载即拒 |

## security（9）

| 案例 | 状态 | 证据 / 差在哪 |
|---|---|---|
| SEC-01 外发默认关闭 | **PASS** | `egress.mode` 默认 `deny`；属性 `mode=deny is absolute…`；宿主级 `will not send state to a cloud destination that was never allowlisted` |
| SEC-02 不可信工具描述 | **PASS** | `untrusted-description.test.ts`：工具描述与参数描述里写满"改成 attacker 端点 / 换模型 / 放开 egress / 把 env 里的密钥打印进每道题"。断言四件事：发往提供方的请求里不含该文本也不含密钥值（快照只带目录摘要）、题集仍是固定模板 id、`runtime.config` 与装载时逐项相等、`egressOccurred=false` 且 fetch 调用数 0。第二条再证一次：换描述只换 `catalogDigest`，动作与 reasonCodes 逐字不变 |
| SEC-03 参数秘密最小化 | **PARTIAL** | 公共日志不再带可猜的参数摘要（`publishes an argument digest only when a key makes it irreversible`）；"参数里的秘密最小化"本身没测 |
| SEC-04 上下文裁剪 | **PASS** | 4 条裁剪属性 + `refuses to ask a provider about a call whose own arguments do not fit the budget` |
| SEC-05 跨会话隔离 | **PASS** | `keeps two sessions from sharing a goal, a history or a task version` + core 作用域属性 |
| SEC-06 本地服务认证 | **PASS** | `python/tests/test_service.py`：逐端点鉴权、令牌前缀不算通过、Host/Origin 拒绝 |
| SEC-07 未知配置 | **PASS** | schema `additionalProperties:false` 全层；`config/examples` 过真 `loadConfig` |
| SEC-08 原始日志默认禁用 | **PASS** | `audit.rawContent` 是 `const:false` + 显式 default，且类型里没有能装原文的字段 |
| SEC-09 权限范围绕过 | **PARTIAL** | guard 压过 waterfall allow 已测；`restrict()` 时序 gate 未过，未开 |

## lifecycle（10）

| 案例 | 状态 | 证据 / 差在哪 |
|---|---|---|
| LIFE-01 用户中途取消 | **PASS** | 协调器取消路径 + `a cancelled request is reported as cancelled, not as an answer`（真实服务 e2e） |
| LIFE-02 排队超时 | **PASS** | 协调器 deadline；服务端 `a deadline spent while queued is a timeout…` |
| LIFE-03 有界队列 | **PASS** | 服务端 429 `QUEUE_FULL` 测试；协调器 `maxQueue`/每会话 fairness |
| LIFE-04 取消的 GPU 任务 | **PASS（以不撒谎的方式）** | 能力固定声明 `discard-only`；不做"已停止计算"的假确认。CPU 路线无 GPU 可测 |
| LIFE-05 卸载在途任务 | **PASS** | `stops observing once the plugin instance is disposed` + 协调器 close 打断在途 |
| LIFE-06 外部服务所有权 | **PASS** | Jev 从不启动/下载；`ownership: managed` 现在拒绝装载，external 不可达时如实 `LOCAL_NOT_READY` |
| LIFE-07 自己引发工具变化 | **PASS** | 两条合起来：`leaves a hidden tool hidden…` 证明 Jev 自身从不 `register`/`restrict`，因此没有自我失效回路可言；`does not mark a pending decision stale for another scope’s catalog change` 与 `does mark it stale when the scope that is waiting got a different catalog` 则把"无关 agent 不被反复判 stale"钉成一对反例（先让两个作用域被展示不同目录，否则两条断言在旧的单一摘要下会同时通过）。摘要在 `system-prompt/assemble` 上按作用域刷新；宿主的 `tools/change` 是零参数、不分作用域的广播，没法从它拿到"谁的目录变了" |
| LIFE-08 反馈去重 | **PASS** | core 属性 + `one attempt is counted once, not once per nested dispatch` |
| LIFE-09 轮询与重复失败 | **PARTIAL** | 重复失败已在真实 loop 上端到端验证；轮询预算只有 core 单测——DSH 结算结果里没有轮询/资源版本信号，adapter 传的是 `isPoll:false`、`resourceVersions:{}`，已在代码里写明而不是猜 |
| LIFE-10 最终结果同步事件 | **PASS** | `execution` 行按 requestId 关联，`status` 来自真实 `tools/result` |

## local-inference（5）／ local-offline（2）

命令：`JEY_RUN_INFERENCE=1 python/.venv/Scripts/python.exe -m unittest tests.test_inference`、`JEY_E2E_LOCAL=1 pnpm --filter jev-provider-local test:e2e:local`

| 案例 | 状态 | 证据 |
|---|---|---|
| LOCAL-01 加载真实权重 | **PASS** | 锁内 sha256 与实文件逐项相符；加载 12–19 s |
| LOCAL-02 预热与常驻 | **PASS** | 常驻服务 + 状态前缀缓存：冷 1.2 s、命中 0.45–0.6 s |
| LOCAL-03 缺失模型 | **PASS** | 缺 tokenizer/权重不符 → `LOCAL_NOT_READY`，`/v1/capabilities` 拒绝虚构身份 |
| LOCAL-04 选项编码 | **PASS** | 答案槽必须是单 token 且拼接不回退（上游 `encode_prompt` 断言），逐题选项集回镜 |
| LOCAL-05 相互不互斥的工具 | **NOT_RUN** | 需要评测集，属 M6 |
| OFF-01 真实断外网 | **BLOCKED** | 需要受控进程/容器 + 负向控制证明阻断真的生效；只设了 `HF_HUB_OFFLINE` 不算 |
| OFF-02 离线依赖未预置 | **PARTIAL** | 请求路径不下载、`local_files_only` 已测；未做断网环境验证 |

## mcp-contract（5）／ pack-install（5）／ semantic-eval（4）／ system-eval（4）

**`mcp-contract` 5 条全部 PASS；pack-install 与两组评测仍全部未跑。** `packages/adapter-mcp` 已建（P1-02），下面的证据都是真实 stdio 子进程 + 官方 SDK 客户端 + 测试进程里的真实 HTTP 服务，没有假传输层。仍没做的：没有可安装的 tgz/wheel 与全新 home 验证（P1-04），冻结数据集/标签/校准分区/统计判定一行都没跑过（P2-01）。云端真实请求 `BLOCKED`（无凭据、无预算）。

命令：`pnpm --filter jev-adapter-mcp test`（27 条：19 单元 + 8 契约）；证据再生：`node scripts/mcp_stdio_transcript.mjs` → `artifacts/mcp_stdio_session.json`

| 案例 | 状态 | 证据 / 差在哪 |
|---|---|---|
| MCP-01 真实客户端握手 | **PASS** | `test/contract/mcp.test.ts` 三条覆盖 initialize/list/call：`MCP-01 …`（官方 SDK `Client` 连一个真实子进程，`tools/list` 发布的 input/output schema 与 `src/schema.ts` 逐字相同，annotations 是只读、非破坏、非开放世界）、`MCP-01b …`（三个工具各调一次；`structuredContent` 与兼容文本是**同一串字节**，并反过来用发布的 output schema 校验）、`MCP-01c …`（提供方换成测试进程里真实 HTTP 监听，答案里的 kind/resolvedModel 来自服务端身份，`synthetic:false`） |
| MCP-02 stdout 纯净 | **PASS** | `MCP-02 puts only protocol bytes on stdout, and stops when its client disconnects`：自己 spawn、逐行扫 stdout，每一行都必须解析成 JSON-RPC 2.0 帧；启动行落在 stderr；一个真实本地 token 在 stdout 与 stderr 里都不出现。顺带断言客户端关掉 stdin 后进程 exit code 为 0。把 `log()` 改指 stdout 时这条会红（已验证） |
| MCP-03 结构化错误 | **PASS** | `MCP-03 keeps a protocol failure apart from a judgement that could not be made`：未知工具 `-32601`、缺 `evidence` `-32602`（协议错误，没有 result），而超预算的合法请求是带 `isError` 的 result（`INSUFFICIENT_CONTEXT`、`retryable:false`、没有 `structuredContent`）。把协议错误也改写成 `isError` 时这条会红（已验证） |
| MCP-04 权限隔离 | **PASS** | `MCP-04 refuses a forged host identity without sending anything`：一次调用里同时塞 `sessionId`/`hostAttested`/`endpoint`/`tokenRef`/`mode` → `-32602`，且**本地服务的收包计数仍为 0**（不是"发出去了但被忽略"）；随后不带伪造键的调用确实到达服务，快照里的 `sessionId`/`agentId` 是服务端自填的 `mcp`。工具面上没有 `jey_execute`/`jey_set_policy`，`adl_*` → `jey_*` 的映射由 `LEGACY_TOOL_NAMES` 与 `schema.test.ts` 记录 |
| MCP-05 客户端断开 | **PASS** | 两半分开钉：`MCP-05 propagates a cancellation to the provider and keeps no orphan work` —— 服务把连接吊住，客户端取消后**服务自己看到 socket 被挂断**（配置的 deadline 是 30 s，所以看到的不是超时），接着第二次调用在 `maxConcurrent:1` 下仍然真的到达服务并拿到 `LOCAL_NOT_READY` 而不是被排队饿死；把 `signal` 换成永不中止的控制器这条就变红（已验证）。`MCP-05b shuts the process down when the client disappears with a call in flight` —— 在途时客户端消失，进程必须自己退掉；旧代码挂住不退，因为 SDK 的 stdio 传输不会自己发现客户端走了，修的是 `src/main.ts` 里监听 stdin `end` 的那一行（缺陷 35） |
| PACK-02 版本不匹配 | **PARTIAL** | 只读 doctor 已实现并实测：`launcher MISMATCH pinned 0.1.7-alpha.1 / installed 0.1.5-rc.2` 判 `NOT_READY`，读不到时报 `UNKNOWN` 而不是"大概兼容"（`doctor.test.ts` 的两条 `unobserved launcher` 断言）。**还差**：从已安装的 tarball 里跑这条命令——目前没有可安装的包（P1-04） |

## 汇总

| gate | PASS | PARTIAL | NOT_RUN | BLOCKED |
|---|---:|---:|---:|---:|
| host-integration | 10 | 3 | 1 | 0 |
| property | 5 | 1 | 0 | 0 |
| provider-contract | 8 | 2 | 0 | 0 |
| security | 7 | 2 | 0 | 0 |
| lifecycle | 9 | 1 | 0 | 0 |
| local-inference | 4 | 0 | 1 | 0 |
| local-offline | 0 | 1 | 0 | 1 |
| mcp-contract | 5 | 0 | 0 | 0 |
| pack-install | 0 | 1 | 4 | 0 |
| semantic-eval | 0 | 0 | 4 | 0 |
| system-eval | 0 | 0 | 4 | 0 |
| **合计 74** | **48** | **11** | **14** | **1** |

48 条 PASS 全部能指到具名测试或一次真实运行；14 条 NOT_RUN 是**没做过**，不是"大概能过"。
本表的分组计数由案例行逐条重算（2026-09-27 三次：一次纠正 `security` 把 NOT_RUN 记成 PASS、
`PACK-02` 整组被写成全 NOT_RUN；一次在 HOST-08/09/11/14、SEC-02、LIFE-07 转 PASS 之后；
一次在 `mcp-contract` 整组转 PASS 之后）。
以后改动案例状态时应重算，而不是手改汇总数字。

## 2026-09-30 Linux 重建复核

原表保留历史基线。新增 POL-02、WIRE-08 及 npm PACK-01/04 证据、以及仍未覆盖的真实规划器、UI、PTC、断网与质量评测边界，见 [本轮报告](RECONSTRUCTION_20260930_LINUX.md)。不要用398条工程检查替代74条验收案例的逐项判断。

后续已新增真实 HMR、完整 wheel 运行时推理、npm 同版重装/卸载/恢复证据；版本升级回滚和模型效果验收仍未完成，详见本轮报告。
