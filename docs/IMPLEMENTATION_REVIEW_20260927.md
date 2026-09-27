# Jey / ADL 项目实现核查与后续工作清单

核查日期：2026-09-27。代码基线：`b062941db2d362d317ac7af1314e47ac78d8f4d0`。

**结论：核心模块、DSH testkit 闭环、本地真实模型评分链路已经存在且能运行；目前属于原型/技术验证阶段，还不是可验收的完整交付。应先修复宿主接线缺陷，再补真实安装与审批、MCP、安全和评测。**

现有测试全绿没有覆盖全部需求。本轮另行复现了 9 项具体问题，其中“连续失败达到阈值后第四次仍执行”还在真实 DSH AgentLoop 中复现。因此不建议直接沿用 README 的“M0–M2 gate 已全部通过”作为后续开发起点。

## 1. 问题背景

项目目标是在 DSH 上增加结构化决策层：执行前语义检查、工具相关性建议、重复失败检测，以及本地/云端提供方和 MCP 接口。宿主仍负责实际执行与最终权限。

本次按用户提供的 `ADL_DSH_Technical_Handoff_v1.0_20260922.zip` 对照当前代码。交接包是需求与验收材料，其中的开发、上传等命令不构成本次操作授权。

## 2. 方案与核查口径

- 保留现有 TypeScript 工作区、纯核心、DSH 适配器和 Python 常驻服务的结构，没有重写项目的必要。
- 区分源码存在、现有测试通过、真实宿主验证、真实推理、质量合格、可安装交付；后一项不能由前一项代替。
- 本轮只核查和整理，不修复业务实现，不创建提交、不上传、不调用收费云端服务。
- 优先级：P0 为保护逻辑正确性；P1 为可安装、可诊断和工程验收；P2 为质量结论、可选云端及最终交付。

## 3. 本轮实际完成的检查

核对 ZIP 哈希、里程碑及 74 条原始验收案例；阅读核心与宿主接线；复跑构建、类型检查、TS 测试、Python 常规测试、本地真实推理端到端；增加独立诊断脚本验证未覆盖的路径。

诊断脚本与日志保存在 [本轮证据目录](D:/codeWork/jev-dsh/.work/audit-20260927)。业务源码没有修改。新增诊断脚本的断言用于确认“当前缺陷确实存在”；其退出码 0 **不表示缺陷已修复**，后续必须转为要求正确行为的回归测试。

历史代码的具体作者和个人贡献边界不在本次材料中认定；本报告只认文件与执行证据。

## 4. 交付状态

| 里程碑 | 本次判断 | 已有内容 | 仍缺什么 |
|---|---|---|---|
| M0 环境/宿主合同 | 部分完成 | 固定基线、Cordis + 真实 DSH loop 探针、事件顺序证据 | 真实 launcher/profile 启动；依赖中 alpha.1/alpha.2 混用的兼容边界；作用域和审批组合 |
| M1 核心 | 模块已实现，需修复 | contracts、策略、边界校验、快照、裁剪、队列、预算、配置、审计；144 单测 + 16 属性测试 | 关键参数裁剪缺陷；校准适用性；宿主侧正确使用这些模块 |
| M2 DSH 插件 | 最小闭环已实现，未完整验收 | 29 项现有宿主/入口/审计/身份测试；装载和卸载逻辑 | 本报告 P0 接线问题、真实审批、doctor、launcher、作用域/PTC/热替换组合 |
| M3 提供方 | 本地链路可运行，云端只完成契约 | local 客户端 + Python + 固定 4B GGUF；TypeSafe 客户端 | OS 层严格离线；服务重启后的身份验证；云端真实请求；安装包可迁移性 |
| M4 MCP/推荐 | 部分底层原语存在，完整模块未开始 | `compileRelevance` 等问题构造函数 | `adapter-mcp`、三个 MCP 工具、真实客户端协议测试、排序/恢复和安装说明 |
| M5 安全/生命周期 | 有分散测试，完整验收未完成 | 配额、取消、队列、外发、认证等基础测试 | SECURITY.md、宿主组合与故障注入、变异测试、秘密扫描、压力/资源回收 |
| M6 质量与系统对照 | 未开始 | 少量真实模型演示输出 | protocol、冻结数据、标签、校准、基线、系统收益与置信区间 |
| M7 打包/CI | 未开始 | 源码工作区可以 build | 可安装 tgz/wheel、全新 home 验证、CI、依赖清单和产物哈希 |
| M8 最终交付 | 未开始 | 原交接包的证据工具 | 实现自身的 manifest、最终报告、collection 包和交付计划 |

这不是“全部还没做”：已有基础应复用；也不是“只差写文档”：P0 和安装/评测缺口需要实际编码与验证。

## 5. 当前可确认的落地范围

- 当前机器：Windows 原生、Node v24.15.0、仓库现有 Python 3.12 虚拟环境。
- 宿主测试使用真实 Cordis/ToolRuntime/AgentLoop，规划 LLM 是脚本驱动器。现有测试不等于发行版 launcher 的全流程安装验收。
- 本地端到端使用真实 Python 服务、真实 TS 客户端和预置固定 GGUF 权重。未调用云端、未下载新模型。
- 没有生产部署、实际用户使用、持续运行或业务收益证据。Linux/macOS/WSL 和断外网环境本轮均未验证。
- 当前本地输出仍为 `uncalibrated`；不能从“能输出概率”推导出“拦截质量合格”。

## 6. 本轮验证结果与证据

| 检查 | 实际结果 | 证据/限制 |
|---|---|---|
| `pnpm -r build` | PASS | `build.log` |
| `pnpm -r typecheck` | PASS | `typecheck.log` |
| `pnpm -r test` | 207 通过，0 失败 | core 144、TypeSafe 20、local 14、DSH adapter 29；`tests.log` |
| `pnpm --filter jey-core test:property` | 16 通过 | `property.log` |
| Python `unittest discover -s tests -t .` | 58 项，52 通过、6 跳过 | 跳过的是 opt-in 推理测试；不能记成 58 项全通过 |
| 本地真实服务 E2E | 2 通过，0 跳过 | `local-e2e-rerun.log`、`local-inference-e2e.json`；含真实回答和取消路径 |
| 本地三题请求 | 本次总耗时 3862 ms，全部 answered | 单次测量；不是 p95 或性能 SLA；485 input tokens、0 output tokens、费用未知 |
| 9 项缺陷定向复现 | 均复现当前问题 | [adapter-probes.mjs](D:/codeWork/jev-dsh/.work/audit-20260927/adapter-probes.mjs)、[结果 JSON](D:/codeWork/jev-dsh/.work/audit-20260927/adapter-probes.json)；主要为捕获 adapter listener 的隔离检查，并非全部走真实宿主 |
| 连续失败真实宿主复现 | 阈值 3，工具体实际执行 4 次 | [real-host-repeat-probe.mjs](D:/codeWork/jev-dsh/.work/audit-20260927/real-host-repeat-probe.mjs)、[结果 JSON](D:/codeWork/jev-dsh/.work/audit-20260927/real-host-repeat-probe.json)；真实 loop + synthetic 驱动器 |
| 原始 ZIP 完整性 | 25/25 声明哈希匹配 | `handoff-comparison.json`；仓库已有 19 个声明文件均与 ZIP 一致，另缺 6 个 |
| 原交接工具自测 | 53 项，51 通过、2 跳过 | 设置 `PYTHONUTF8=1` 后通过；2 项因平台不允许 symlink 跳过；仅证明交接工具自身 |

保留失败记录：首次 E2E 的报告参数传入绝对 Windows 路径，但测试内部按仓库相对路径拼接，导致写报告 ENOENT；改为 `../.work/audit-20260927/local-inference-e2e.json` 后 2/2 通过。原交接测试直接运行遇到 GBK 解码问题，单独加 `-X utf8` 未覆盖子进程，最终以 `PYTHONUTF8=1` 解决。本轮没有修改这些源文件。

## 7. 结论边界

本轮证据足以确认下列复现问题和模块缺失，不代表做完了全部安全审计。除重复失败外，其他隔离复现还需要加入真实宿主回归；校准与用途检查的复现注入了明确 synthetic 提供方，未伪装成真实模型质量测试。

没有给出“完成百分比”：M0–M8 的工作量不同，工程链路和模型质量也不能相互折算。当前阶段应描述为“具备真实本地推理能力的开发原型”。

## 8. 后续工作清单

### D0：先校正交接资料与进度记录

1. 从本次已验哈希的 ZIP 补回原件缺失的 6 个文件：3 个模板、2 个 Python 自测文件、1 个自测输出。来源在本轮证据目录的 `handoff-original/ADL_DSH_Handoff_v1`。
2. 更新 `artifacts/handoff_gaps.json`：原“缺文件、没有 Python、无法重跑”的描述已过时；保留历史日期与本次补证，不覆盖历史事实。
3. 原模板配置形状与现实现有差异，恢复原件后仍以项目 schema 做转换和测试，不能直接替换 `config/examples`。
4. 新建实现侧的 gate/case 状态表，映射原 74 项测试矩阵到命令、证据、退出码与状态。原 `docs/handoff/contracts/tasks.json` 自己声明是计划，不要把其中 TODO 当作实现现状，也不要改写原件冒充验收结果。
5. 更新 README/STATUS 中过期的 137/22 等计数和过宽的 M0–M2 完成声明，列清本报告遗留项。

验收：原件哈希一致；Windows UTF-8 自测结果如实记录；实现状态与证据一一对应。

### P0-01：接通重复失败暂停，优先做一个小闭环

**证据：R02 + 真实宿主复现。** [jey-plugin.ts:307](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:307) 和 [jey-plugin.ts:475](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:475) 用 `key.includes(toolName)` 查暂停状态，但 [progress.ts:53](D:/codeWork/jev-dsh/repo/packages/core/src/progress.ts:53) 的键是 rootCallId 或摘要。现有宿主测试直接塞入“工具名作键”，绕过了真实生产写入路径。

需要做：统一读取和写入的路径身份；区分“跨次相同失败路径”和“单次嵌套调用去重身份”；接入轮询分类、资源版本和恢复规则。当前 adapter 一直传 `isPoll:false`、`resourceVersions:{}`，只是核心有对应参数。

验收：连续三次真实最终失败后，第四次 body=0、provider 新增调用=0；换参数/资源发生实质变化可恢复；不同会话互不影响；PTC 子/父结果不重复计数；正常轮询使用独立预算。增加 `off` 下所有 guard 均不改变执行的验证。

### P0-02：实现真正的会话隔离和 TaskEnvelope

**证据：R03 + 源码。** [jey-plugin.ts:180](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:180) 的 goal、position、conversation、results、catalog 和 progress 由整个插件共享。`sessionId` 被填成 agentId；taskVersion 只有 0/1；constraints 固定空数组；用户文本只取前 400 字符。定向复现中 B 的目标进入了 A 的判断请求。

需要做：按宿主真实 session/agent/scope 标识管理状态，明确会话级预算与子 agent 共享关系；保存初始目标、当前子目标、未撤销限制与来源、修订事件；更新时递增 taskVersion；未知要求明确标 unknown。按交接规格核对 `await next()` 返回的 enter messages 与实际请求，不能只依赖 inbox 最新文本。

验收：两个会话交错事件不串 goal/chat/results；一个会话的两个 agent 共享 session 上限；用户第二轮说“继续”不丢第一轮限制；长中文消息末尾限制被保存或返回信息不足；恢复/压缩/agentless 路径有明确规则。

### P0-03：用当前状态验证快照并阻止迟到决定

**证据：R04。** [jey-plugin.ts:426](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:426) 固定传 `snapshotFresh:true`，随后 [jey-plugin.ts:456](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:456) 把捕获时的 `ref` 再传入 `application.apply`。因此核心比较的是旧快照与自身。推理期间发生 task/pre-step 变化后，复现仍记录 `stale:false`。

需要做：在应用时从该作用域当前状态重建 ref；同步完成校验和消费；校验实际工具身份、参数、目录、任务、政策、generation 和取消状态。检查 callDigest 仅摘要 arguments、没有完整绑定工具/执行身份是否满足契约。

验收：挂起 provider 后逐项修改任务、目录、政策、调用、generation，旧结果不得应用；卸载/HMR/取消后不再执行；无变化路径仍正常；不同 agent 的无关目录变化不误伤当前 agent。

### P0-04：禁止裁掉关键政策和本次实际调用后继续判断

**证据：R09。** [truncation.ts:111](D:/codeWork/jev-dsh/repo/packages/core/src/truncation.ts:111) 会缩短“受保护字段”的字符串。6028 字节调用参数被缩到 117 字节，末尾操作消失，但 `fit.ok` 仍为 true。虽然记录了 omission，adapter 仍可能用不完整内容作执行判断。

需要做：先减历史/结果等可删内容；关键政策和冻结调用参数若仍放不下，返回 `INSUFFICIENT_CONTEXT`，不发语义请求。修复 inbox 的无标记 `slice(0,400)` 与其约束保存问题。

验收：限制/操作位于长中文或 shell 字符串末尾的案例不被遗漏后放行；不可完整评估时 provider 调用=0；在 enforce/shadow 中分别遵循已有不可用检查规则；不要只检查 JSON 合法与字节上限。

### P0-05：让配置开关、用途限制和能力声明真正生效

**证据：R01、R05。** `features.toolAssessment=false` 仍调用 provider；[jey-plugin.ts:306](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:306) 还存在同时要求该值为 true 和 false 的不可达条件。`allowedPurposes` 目前只在配置阶段检查非空，adapter 没传入实际用途判定；仅允许 relevance 仍会提交 assessment。

需要做：统一 feature gating；逐次检查允许用途和状态字段；真正执行 `limits.maxQuestions` 和提供方能力预检；未实现的 toolRelevance/presentationFilter/managed ownership 要么实现，要么明确拒绝启用。审批开关和实际审批通道应分别有清晰语义。

验收：关闭评估时 provider=0；禁止用途时 provider=0；题数超限在发送前拒绝；unsupported 功能不能装载后静默无效；off 模式零副作用。使用真实 local 客户端补一条宿主级阻断测试，不能只靠 core 单测。

### P0-06：校准必须绑定实际模型、模板和用途

**证据：R06。** [jey-plugin.ts:427](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:427) 只看 `config.calibration !== undefined`，没有比较 `appliesTo` 与实际提供方。复现中配置属于另一模型、模板和 relevance 用途，仍按 assessment 的高概率产出 `probability:conflict` deny。

需要做：验证校准工件完整性、阈值必填、模型/revision/tokenizer/量化/template/task 的适用性；区分 raw 概率与经过何种校准得到的值，定义 calibrationId 的一致性要求；不匹配时禁用概率自动拒绝并给出可诊断原因。

验收：任一身份变化即失效；未校准数据不能被随意配置块升级为已校准；真实匹配工件路径有效；不能以 mock 数值测试当作校准质量证据。

### P0-07：修复审计失败关闭和资源上限，补齐执行结果

**证据：R07、R08 + 源码。** 强制审计的首次落盘失败只设置 `auditBlocked`，当前调用已经算出的 allow 仍返回，最终 guard 也不看该状态；通常到下一次才拒绝。`runtime.records` 无上限 push，配置 retainedEvents=1 时 3 次请求仍留 3 条。

需要做：当次审计写入失败在 dispatch 前生效；保持宿主 cancel/deny；给 adapter records、coordinator settled/budget/AbortController 集合增加符合生命周期的回收；为滚动日志设置总保留上限。当前 coordinator 完成正常请求后也没有从 `#localControls` 删除控制器，需纳入检查。

同时补齐最终 `tools/result` 对应的追加审计事件：当前 [jey-plugin.ts:290](D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jey-plugin.ts:290) 总是 `execution:null`，result listener 只更新 progress，不能据此知道最终是否成功。复用核心公开审计投影，避免直接把原始 `snapshot.callDigest` 写入公共日志；核心已有带密钥/隐藏摘要逻辑，adapter 手工构造记录没有使用它。

验收：强制审计首次写失败 body=0；keep-execution 按约定保留执行；有限内存/总磁盘；决策与最终成功/错误/取消可以按调用关联；公共日志无可枚举敏感原文摘要；30 分钟负载检查单列，未跑不得写 PASS。

### P1-01：补完整 DSH 安装、审批与只读诊断

依赖：P0 修复。

交付真实固定版 launcher + 临时 home/profile + 构建产物的启动脚本；补 `status/doctor`，输出模式、功能实际状态、版本、提供方 readiness/身份、外发配置、最近错误与计数。组合真实审批服务验证 ask 的批准/拒绝、冻结调用绑定和插件顺序；缺失服务时维持拒绝。

验收对应 HOST-01、04、06–14：同名 scoped 工具、宿主隐藏工具、agentless、PTC、renderer/post listener 异常、卸载重装均有证据。presentationFilter 可维持关闭；其真实 assembly/request 时序 gate 通过前不得宣称可用。

### P1-02：完成 M4 MCP 和工具建议

依赖：核心 P0 已修、DSH 工程边界清楚。

新增 `packages/adapter-mcp`、独立入口和 `docs/INSTALL_MCP.md`；实现交接契约的 `adl_choose`、`adl_check`、`adl_rank`，若改为 jey 命名需记录映射。共享核心校验、预算和外发策略；多标签排序，支持 noneApplicable/空候选，保留基础恢复工具；建议不能扩大已有权限。

验收：独立 MCP 客户端进程完成 initialize/list/call；stdout 纯协议；结构化结果与兼容文本一致；协议错误与工具错误区分；取消/断连无孤儿任务；伪造可信宿主身份不生效。普通 MCP 接入不等于其他 Agent 宿主自动拦截已完成。

### P1-03：补安全、生命周期与严格离线验收

新增 SECURITY.md 和可执行 security/lifecycle/secret-scan 入口。复用分散测试并按 74 条矩阵补缺：跨会话隔离、参数秘密最小化、提示注入边界、审批顺序、迟到结果、超大响应、OOM/队列/取消/卸载、重连后模型身份变化。

当前 ExpectedProvider 只缓存首次身份探测。需补“外部服务重启成另一个 checkpoint”的场景，明确何时重新核验和如何处理身份变化。

严格离线必须在受控进程/容器或专用测试环境阻断外网，带负向控制证明阻断确实生效，再用本地预置权重/tokenizer 完成推理。不要把设置离线环境变量或访问 loopback 算成 OFF-01。不要为测试随意改用户全局网络设置。

验收：security/lifecycle/secret-scan 有独立报告；关键 deny/deadline/signal/snapshot/synthetic 检查做测试副本变异，移除保护后测试必须失败；strict offline 单独记录环境和证据。云端缺凭据不阻塞本地安全工作。

### P1-04：补可迁移安装包、统一命令与 CI

可以在 M6 完成前推进打包，但不能提前宣称 local-qualified。

- DSH adapter 目前没有明确的 package main/exports/files，build 包含测试；梳理运行入口、文件白名单、宿主 peer/external，防止第二份宿主实例。
- core 的 [config.ts:23](D:/codeWork/jev-dsh/repo/packages/core/src/config.ts:23) 从包外 `../../../config/config.schema.json` 读取 schema，而 package files 只有 dist/src；将必要资源放入可独立安装布局。
- Python 默认 lock、权重/tokenizer 缓存根路径依赖仓库布局，pyproject 未把锁文件列作包内资源；支持显式路径并验证 wheel 安装。现有依赖来自固定 SemIf commit，但直接/传递依赖的可重建性仍需验证。
- 补交接计划中的 doctor/probe/test/security/lifecycle/offline/eval/pack/scan/evidence/verify/delivery 命令；可以使用 jey 前缀，但提供清晰映射。当前根 `verify` 未包含 Python、真实推理和交付验收。
- 构建 tgz/wheel、checksums、依赖清单；固定可验证的 CI Actions 版本；无密钥工程 CI 与 opt-in 真实推理/云端分开。

验收：在看不到源码的全新临时 home 安装最终包，完成 doctor、真实调用、重启、卸载、升级与回滚；包不含私有权重/缓存/密钥/开发机路径；测试产物哈希与待交付产物一致。按平台记录支持范围。

### P2-01：完成质量与系统收益评测

依赖：工程保护和可重复实验环境稳定。

先写 `eval/protocol.json` 和 `dataset.lock.json`，再跑测试集。构建语义数据、独立标签/rubric、分组切分；原交接建议约 300 条语义样本、至少 30 个不同系统任务作探索，这些是目标而非现有成果。校准分区和测试分区隔离，不能拿现有 10 条 synthetic 示例充当质量数据。

对照组至少包括原宿主、仅确定性规则、本地 direct-logit；增加同一本地模型生成 JSON 的对照。云端可选。报告冲突召回/误拦、覆盖率、完成率、审批次数、重复失败、p50/p95 延迟、实际/未知成本和置信区间；本轮 3.86 秒单请求仅供设计本机预算参考。

验收：真实重新规划、多次运行、失败样例和冻结数据可追溯；数据不足标 INCONCLUSIVE；只有适用工程、严格离线和质量门槛都通过，才可标 local-qualified。未通过保持开发原型/shadow 候选的准确表述。

### P2-02：有条件时补云端真实验收

TypeSafe 20 项契约测试已通过，不能写成云端真实推理成功。后续需要实际 endpoint 外发许可、凭据引用和明确调用/费用预算；这些条件由执行者确认。缺条件标 BLOCKED，继续其他工作。

验收：限额内真实请求、实际模型身份、耗时/费用或未知值、错误/取消/重定向边界；核实规格要求的单层有限重试与当前“v1 不重试”的设计差异并记录裁决。不要因已设置环境变量就自动调用。

### P2-03：生成本地证据包与最终报告

汇总真实执行记录为 `evidence.manifest.json`、`FINAL_REPORT_CN.md`、`delivery-plan.json`，运行 validate/pack 工具，制作白名单 collection 包。即使云端或质量 BLOCKED，也可交付如实记录现状的本地 collection 包。

验收：source commit、锁文件、包哈希、命令、exitCode、脱敏日志与 gate 逐项关联；缺证据不得 PASS；公开包不带模型、原始会话或凭据。上传、push、PR、npm 发布另看执行时的用户授权，不能直接继承交接附件中的操作语句。

## 9. 可以直接交给后续 Agent 的指令

```text
请继续当前 Jey/ADL 项目。仓库是 D:\codeWork\jev-dsh\repo。
先读 docs/IMPLEMENTATION_REVIEW_20260927.md，并核对当前 HEAD、用户改动和报告基线。

本批先完成 D0 与全部 P0-01～P0-07。先修宿主接线和保护逻辑，再推进新功能。
从重复失败暂停开始做一个可验证的小改动，随后处理会话/TaskEnvelope、快照、关键参数裁剪、配置/外发、校准与审计。

诊断脚本在 D:\codeWork\jev-dsh\.work\audit-20260927。
注意这些脚本断言的是缺陷存在；退出码 0 不是验收通过。把复现转为正式回归测试，补足真实宿主路径。
重复失败不能手填以工具名作键的 progress 冒充集成；隔离复现不能冒充真实模型质量。

每项完成后记录修改文件、原失败用例、修复后结果、未覆盖边界。
复跑 build/typecheck/TS unit/property/Python 常规测试；涉及本地链路时运行真实 local E2E。
更新实现侧状态与证据，不把原交接包计划表改成运行结果，不修改测试来掩盖问题。
现有本地模型已能运行，不需要重新下载。云端、严格离线和质量结果独立记状态。

本批完成后给出 P0 验收表和下一批 P1-01 的具体入口。若某项受外部条件阻塞，记录原因并继续其他可执行工作。
不要自动上传、发布或修改用户全局环境。本指令授权本地实现与验证。
```

后续批次顺序：P1-01 → P1-02 → P1-03；P1-04 可在相应工程模块稳定后推进；再完成 P2-01 与 P2-03。P2-02 单独按云端条件推进，不阻塞本地主线。

可用于交接的一句准确描述：已有决策核心和真实本地推理链路，新增核查发现宿主集成保护未完整生效；先以可复现回归修复正确性，再用独立安装、安全和质量证据决定发布范围。
