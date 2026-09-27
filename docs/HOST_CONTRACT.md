# HOST_CONTRACT：DSH 宿主固定合同（M0）

核对日期：2026-09-22。核对人：本地编码 Agent。
基线：`deepseek-ai/deepseek-harness` @ `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`（提交信息 `Merge pull request #4901 from deepseek-harness/rel/dsh-0.1.7-alpha.1`，2026-09-22T04:12:33Z）。
本文件中的每一条都指向固定提交内的真实文件或 npm 注册表查询结果；没有一条来自推测。若与 `docs/handoff/docs/01_TECHNICAL_SPEC_CN.md` 冲突，以本文件为准并先写 ADR。

## 1. 安装与运行时事实

| 项 | 实测值 | 来源 |
|---|---|---|
| monorepo 根包 | `@deepseek-ai/dsh-root` `0.1.7-alpha.1` | `package.json` |
| npm 发布 | `@deepseek-ai/dsh` 存在 `0.1.7-alpha.1`，dist-tag `alpha`；`latest` 仍为 `0.1.5-rc.2` | `npm view @deepseek-ai/dsh dist-tags` |
| Node 下限 | `^22.19.0 \|\| >=24.0.0` | `package.json` `engines` |
| 本机 Node | v24.15.0 → 满足 `>=24.0.0` | `node --version` |
| 依赖解析 | `npm install --dry-run @deepseek-ai/dsh@0.1.7-alpha.1` 成功解析 512 包 | 本次执行 |
| Cordis peer | `@deepseek-ai/cordis ^4.0.3`（已发布 4.0.3，但 `latest` 标签停在 4.0.2） | `npm view @deepseek-ai/dsh-agent-loop@0.1.7-alpha.1 peerDependencies` |
| 测试基座 | `@deepseek-ai/dsh-agent-loop-testkit@0.1.7-alpha.1` 已发布 | npm |

**与交接包的差异**：交接包自测记录写“本次 Node 不满足 DSH Node 下限”，因此未做任何宿主验证。本工作区 Node 24.15.0 满足下限，所以 M0 的原生探针在本机是可执行项，不是 BLOCKED 项。

## 2. 插件模型

DSH 插件是一个导出 `name` 和 `apply(ctx)` 的 TypeScript 模块，通过 `cordis.yml` overlay 以绝对路径注入（`docs/user/develop/basic/index.md`）。`ctx` 类型来自 `@deepseek-ai/cordis`。

扩展点在源码里以 `declare module '@deepseek-ai/cordis' { interface Events { … } }` 声明，并带 JSDoc `@mode` 标记（`waterfall` 可改写、`emit` 只广播）。

## 3. 本项目将使用的扩展点（逐字签名）

文件：`packages/core/tools/src/index.ts`，均在 `Scoped<ToolRuntime>` 上。

| 事件 | 签名 | mode |
|---|---|---|
| `tools/pre-execute` | `(exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>` | waterfall |
| `tools/execute` | `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>` | waterfall |
| `tools/post-execute` | `(exec, result: Readonly<ToolExecutionResult>, next) => Promise<PostToolDecision>` | waterfall |
| `tools/result` | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined` | emit |
| `tools/change` | `() => void` | emit |

```ts
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string }
```

`index.ts:147-152` 的注释确认：`next()` 委托到 allow；缺少审批支持时 `ask` 转为拒绝；异步 gate 必须观察 `exec.signal`；注册表在它们 settle 之后会重查取消，但不会丢弃其 promise。

单调 guard（`index.ts:720`、`1123`）：

```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
guard(guard: ToolGuard): () => void   // 返回精确 disposer
```

JSDoc 明确：guard 在可扩展 waterfall **之后**运行；任一分层返回字符串即拒绝，没有任何 guard 能强制放行别的 guard 已拒绝的调用。→ 交接包的“同步 guard 只拒绝”结论成立。

作用域限制（`index.ts:1084`）：`restrict(filter: ToolRestriction): () => void`，且带四条运行时抛错守卫——必须 `agent.ctx`（全局 ctx 会遮蔽所有 agent）、`restrict({})` 视为空操作即报错、不得点名保留的 PTC 传输工具 `RUN_CODE_NAME`、点名未知全局工具即报错。→ 交接包“restriction 是作用域过滤、不是安全屏障”成立，且实际比描述更强：误用会立即抛错。

Agent / system prompt 侧（`packages/core/scope/src/scoped-events.generated.ts:18,19,31,34,36` 确认这五个事件均为 agent/scope 作用域）：

| 事件 | payload |
|---|---|
| `agent/pre-step` | `{ agent, messages: UserMessage[], turn, step, signal }` → `PreStepDecision` |
| `agent/request` | `{ agent, turn, step, signal }` → 包装 `LlmCallConfig` |
| `system-prompt/assemble` | `(assembly: PromptAssembly, context: AssembleContext, next)` |

```ts
export interface PromptAssembly { sections; contexts; tools: ToolSchema[]; variables }
export interface LlmCallConfig { provider; model; reasoningEffort?; temperature?; maxTokens?; stop? }
```

`LlmCallConfig` 不含 tools。→ **模型可见工具集唯一来源是 `PromptAssembly.tools`**，§8.2 的 presentation-only 筛选只能落在 `system-prompt/assemble`，无第二条路径。

## 4. 生命周期顺序（R-01 已在宿主源码证实）

`packages/core/agent-loop/src/agent.ts` `preStep()`：

```
271: const assembly = await this.loopCtx.systemPrompt.assemble(...)   // 先组装，含 tools
275: const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, ... })
283: return { ...decision, assembly }
```

同文件 `toolsChanged()` 用 `session.requestHeader()` 比对 assembly.tools，说明宿主自己承认“组装后的工具集可能与已记录请求头不同”。

结论：在 `agent/pre-step` 内调用 `restrict()` 只影响**下一步**的 assembly，当前步发往模型的 schema 已冻结。R-01 成立，且属宿主固有性质而非某插件缺陷。→ 硬筛选必须走 `system-prompt/assemble`；本项目在通过 §8.2 gate 前保持建议模式。

**2026-09-27 实测证实了这条，并补上一半更糟的后果**（`scoped-tools.test.ts` 的
`shows that a restriction made inside pre-step reaches only the next assembly`）：
在 `agent/pre-step` 里 restrict 之后，本步的 assembly 依然带着被禁的工具（模型被展示了它），
而派发时 `resolveExecution` 已解析不到它 —— 工具体不跑，宿主返回一个错误结果。Jey 在这条调用上
正常被问到、投了 `abstain`/宿主 `allow`，执行行却是 `failed`：一层在自己刚刚认可过的调用上
出现了它无法解释的失败。这就是"筛选只能落在 assemble"的实证理由，也是
`presentationFilter` 继续拒绝装载的原因。

## 5. 工具 JSON Schema 是强制子集

`docs/subsystems/tools.md:100,421-451`：作者 DSL `ValueSchemaSpec` 仅支持 `string|number|integer|boolean|null|array|object|json|oneOf`，标量 `enum/const` 必须匹配节点类型，显式 object 必须声明 `additionalProperties: true|false`。原始 JSON Schema 走 `assertSupportedJsonSchema()` / `validateJsonSchemaValue()`，**不支持的关键字是 reject 而非忽略**；`oneOf` 需 ≥2 分支且恰好命中一个。

→ 交接包 S05 的警告成立且需要具体工作量：`packages/contracts` 与 MCP 侧的 schema 必须在宿主边界做子集映射，映射失败要报 `UNSUPPORTED_CAPABILITY`，不能交给宿主抛错。

## 6. 与参考项目 `buberlo/dsh-jev` 的关系

固定提交 `d2f77a1f68906d1576caaa8aa22be65913905d19` 已核。三个风险点复核结果：

- **R-01 ACCURATE（比交接包更强）**：`adapters/pre-step.ts:25` 注册 `agent/pre-step`，`:146` 调 `agent.ctx.tools.restrict({ allow })`；宿主侧顺序见本文件第 4 节。该仓库 `docs/architecture.md:64` 与 `pre-step.ts:5-8` 的自我描述（“在模型请求组装前准备”）与源码不符。
- **R-02 ACCURATE**：`pre-step.ts:26` 先 `await next()`，`:29` 从 `payload.messages` 取消息；而宿主提交的是 `decision.messages`（`PreStepDecision` 变体 `{kind:'enter', messages}`）。第三方插件改写输入时，参考实现读到的是旧输入。
- **R-03 PARTIALLY ACCURATE**：截断属实（`pre-step.ts:57-69`，`maxStateChars` 默认 4000）；但“摘要”措辞不准确（无模型参与），且它有跳过 `source.kind !== 'user'` 的三层回退。→ 测试矩阵里该场景应断言“最近一条用户文本 + 截断语义”，不要断言“摘要质量”。
- 许可证：该仓库整体 MIT（根 `LICENSE`，`package.json` `license: "MIT"`），借用具体实现需保留版权声明。ADR-001 的独立实现决定不受影响。

## 7. 提供方合同修正（影响 M3 代码，需写进契约）

1. `questions` 是**以调用方自选 ID 为键的 map**，不是数组。交接包未写这一点。
2. 缺少凭据时真实返回 **403** `{"detail":{"error_type":"authentication_error", …}}`，而 `docs.typesafe.ai/api` 的错误表写的是 401。适配器两种都要处理。
3. 端点不止 `POST /v1/systemone`，还有 `GET /v1/models`。“单端点”表述需修正。
4. 已记录限制：Choice ≤255 候选；Score 2–10 档；64k tokens/请求，state + 最长问题 32k；约 250k tokens/s、1200 req/min；输出 token 免费；**未公布单次问题数上限，也未公布免费额度**；官方声明限额“动态调整”。
5. 计费：文档给出每 Btok/Mtok 输入价，无费用字段 → 按 §10.4 用调用数/字节上界，成本记 `null`。

## 8. 本地推理可用性（M3 的关键前提）

`TheoLeeCJ/SemIf` @ `1f2dea3e…`（PR #18 合入 llamacpp CPU backend）核实：MIT 许可证；入口是 CLI console script `semif-score = semif_phase1.cli:main`，`--backend torch|mlx|llamacpp`、`--device auto|cuda|mps`；仓库内 grep `fastapi|uvicorn|aiohttp|http.server|grpc|jsonrpc` 源码命中为 0 → 交接包“SemIf 不原生提供本项目 HTTP API、常驻 RPC 是新增工作”成立。
约束：需 Python ≥3.10；`--model/--revision` 即使走 `--gguf` 也必填，`llamacpp_backend.py:227` 会 import `transformers` 取固定参考 tokenizer，因此**启动阶段需要 HF 可访问 `Qwen/Qwen3.5-4B@851bf6e8…`**；CPU 最小权重约 3.01 GB（`bartowski/Qwen_Qwen3.5-4B-GGUF@4168f45a…`）。
本机状态：无 Python，但有 `uv 0.11.32` → Python 3.10+ 可按需装。权重下载属外发动作，需明确授权后才做。

## 8.1 已按实测修正的适配细节（M3）

写 `jey-provider-typesafe` 时逐字用了官方文档的响应示例，并据此确定：

- 请求体 `questions` 是**以我方 id 为键的 map**，每题 `{type, instructions, criteria}`；`criteria` 按 primitive 变形（noul 可省、choice 是 id→评分说明的 map 且 ≤255、score 是 2–10 项的有序数组）。
- 响应是 `{model, answers, usage}`，`answers` 按同一批 id 回镜；`usage` 只有 `input_tokens`/`output_tokens`，**没有任何费用字段** → `costUsd` 记 `null`、`costBasis` 记 `unknown`。
- noul **没有** `confidence`；choice/score 有。适配器对 noul 上出现的 `confidence` 直接拒绝，因为那意味着线格式变了。
- 缺凭据在现网是 **403**，文档写 401，两者都按 `AUTH` 处理。
- 3xx 一律拒绝跟随：一个被允许的 origin 不该能把我们的 state 转交给另一个 origin。
- v1 **不重试**：重试只能有一层负责，协调器与提供方同时重试会让请求数相乘，而重复请求即使输出免费也照样有代价。因此限流表现为一次失败的检查，由策略层升级处理而不是被悄悄吞掉。

## 9. MCP 版本决定

`modelcontextprotocol.io/specification/2025-11-25/server/tools` 存在且核实（`inputSchema` 必填、`outputSchema` 可选、结构化结果在 `structuredContent`；协议错误用 JSON-RPC 码如 `-32602`，工具执行错误用 `isError: true`）。但已发布日期版本含 **`2026-07-28`（current）**，`2025-11-25` 已被取代。→ 需要 ADR 决定固定哪一版；本文件先按交接包指定的 `2025-11-25` 实现并记录差异。

## 10. 真实运行时探针结果（M0 已执行）

`packages/adapter-dsh` 用已发布的 `@deepseek-ai/dsh-agent-loop-testkit` 装配真实
Cordis 上下文 + 真实 `ToolRuntime` + 真实生产 `AgentLoop`，只有 LLM 换成脚本驱动器；
全程离线、无密钥。证据在 `artifacts/compatibility.json`，其中事件序列可用
`JEY_TRACE_FILE=<path> pnpm --filter jey-adapter-dsh test` 重放并逐字节比对。

单轮两步实测顺序：

```text
assemble → pre-step → llm-request → pre-execute → pre-execute-decision
        → guard → execute → post-execute → result → assemble → pre-step → llm-request
```

已证实（PASS，7 个测试）：

- 第 4 节的 R-01 顺序在**运行时**成立，不再只是源码推断：`assemble` 严格早于 `pre-step`。
- 模型可见工具集只来自 `PromptAssembly.tools`；同一 assembly 投影到 request 头的工具集逐项相等。
- `tools/pre-execute` 返回 `deny` 后工具体不执行，模型读到 `Error: probe-policy-denied`，序列中无 `execute`。
- 同步 `guard()` 的拒绝压过内层 waterfall 的 `allow`：`pre-execute-decision:allow` 仍不执行；且 `guard` 位置在 `pre-execute` 之后，与源码注释“guard 在可扩展 waterfall 之后”一致。
- `tools/result` 的 `exec`、`result`、`result.content` 全部冻结，两次就地写入都抛 `TypeError`，模型可见值不变。
- 冻结参数在 `pre-execute` 处可见且不可变。

未证实与降级（如实记录）：

- **`ask` 的授予 BLOCKED**：注册表经 `ctx.get('approval')` 解析审批，本探针未组合
  `dsh-user-approval`。实测得到的是文档所述降级——`ask` 变成拒绝（`Error: probe-ask`）。
  → 因此 §13 的“开启审批却没有宿主能力必须启动失败”从设计条款变成可测要求：Jey 必须
  在装载时探测宿主是否真的提供审批通道，并把 `approvalChannel` 据实传给 `evaluatePolicy`，
  不能凭配置假定。
- **`ctx.tools.restrict()` 未演练**，不记任何结论（第 8.2 节 presentation-only gate 仍未开始）。
- ~~真实 `@deepseek-ai/dsh` 发行版的 `cordis.yml` overlay 加载未做~~：**2026-09-27 已做**，见 §13。

## 11. 本文件需更正的四处

1. **Cordis 入口不是 `create()`**。交接包与常见 Cordis 用法都写 `import { create } from '@deepseek-ai/cordis'`，
   在本固定版本上是 `TS2307/TS2339`；真实入口是 `new Context()`。所有后续宿主代码以此为准。
2. **版本树是混装的**。`@deepseek-ai/dsh@0.1.7-alpha.1` 对其兄弟包声明 `^0.1.7-alpha.1`，
   因此直接依赖可钉到 alpha.1，但 9 个未被任何包显式钉住的叶子包
   （`dsh-brand`、`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-timeout`、`dsh-typert-protocol`、
   `dsh-user-approval`、`dsh-ptc-runtime`、`dsh-util-crypto`、`dsh-util-values`）
   解析到了 `0.1.7-alpha.2`。这正是交接包禁止的“源码最新分支与已发布旧包混装”，
   在 CI 里必须靠 lockfile + `pnpm dedupe`/overrides 固定，不能靠 `^`。
3. 扩展点签名与本文件第 3 节逐字一致，**无漂移**。
4. **effect 内抛错会连带拒绝 `ctx.plugin()`。** 实测：`apply` 里注册的 effect 抛 `ConfigError` 时，`await ctx.plugin(plugin, config)` 一起被 reject，插件不会半装上去。**但这只在进程内的 `ctx.plugin()` 层面成立**：发行版 launcher 在 `0.1.7-alpha.1` 上会把这条失败归类成"未激活条目"并继续启动（见 §13）。所以"配置被拒 ⇒ 整个宿主起不来"不能对宿主做保证，只能对自己保证。

## 12. M0 gate 状态

| gate | 状态 | 说明 |
|---|---|---|
| compatibility | **PASS（本地运行时部分）** | 顺序、工具投影、deny、guard、结果冻结均已在真实 loop/ToolRuntime 上执行并通过；`artifacts/compatibility.json` 可重放 |
| compatibility · 发行版 overlay 加载 | **PASS** | `0.1.7-alpha.1` 真实 launcher + 临时 `DSH_HOME` + `--patch` overlay 装载构建产物；`scripts/host_boot_check.mjs` 可重放，证据 `artifacts/host_launcher_boot.json`（见 §13） |
| compatibility · `ask` 授予通道 | **PASS** | 已组合真实 `@deepseek-ai/dsh-user-approval`，授予/拒绝/无人应答三条路径各自有测试（见 §14） |
| compatibility · `restrict()` 时序 | **PASS** | §4 的结论已用真实 loop 实测（pre-step 里的 restrict 对本步 assembly 无效），并量出"本步被展示、派发时不可解析"的后果 |

## 13. 真实 launcher 核实（2026-09-27 执行）

方式：临时 `DSH_HOME`（不碰 `~/.dsh`）→ `npm install @deepseek-ai/dsh@0.1.7-alpha.1`（240 个
`@deepseek-ai` 包，519 MB）→ `dsh --profile web --patch <overlay> --dump-config` / 真启动，
`--port 0 --no-open`。脚本 `scripts/host_boot_check.mjs`，结果 `artifacts/host_launcher_boot.json`。

三条对后续设计有约束的实测事实：

1. **装载被拒不会中止宿主。** `dsh-app-boot` 的 `boot()` 只对硬编码的
   `requiredStartupEntryIds`（`agent-loop`、`webserver`、`modules`、`connection`、
   `headless-runner`、`acp`、`sdk-jsonrpc-server`）判死；第三方条目抛错被归入
   `dsh: warning: N entry did not activate`，然后照常 serve（退出码 0）。
   同一份配置在 `0.1.5-rc.2` 上得到的是 `plugin tree failed to load` + 退出码 1 + 不监听。
   ⇒ **一个本应 enforce 的部署，如果配置被拒，会以"完全没有 Jey"的状态继续运行**，
   外部唯一信号是那行 warning。第三方插件没有任何开关能把自己的激活变成必需。
2. **装载期 info 日志被过滤。** 启动 exporter 是 `levels: { default: 2 }`（warn 及以上），
   插件的 `info` 行在 boot 窗口内不可见。⇒ "我装载好了、当前是什么模式"不能靠宿主日志证明，
   改由 Jey 自己的审计通道承担：装载成功即写一行
   `diagnostic / mounted:mode=… provider=… egress=…`（不含端点、路径、凭据引用）。
   这也给外部看门狗一个可判定信号：启动后没有 mount 行 = Jey 不在。
3. **`DSH_HOME` 可整体重定向**，profile 目录在 `$DSH_HOME/profiles/<name>`；每次 boot 都会用
   内置默认文本重写该目录下的 `cordis.yml`（内容幂等，但要意识到 launcher 会写用户目录）。
   `--patch` 叠加层是唯一不动用户文件的注入方式。

## 14. 审批接缝（2026-09-27 实测）

来源：`@deepseek-ai/dsh-user-approval@0.1.7-alpha.1` 的发布产物 + `@deepseek-ai/dsh-tools`
的 `prepareExecution()` / `serviceAsk()`，都在真实宿主测试里跑过（`approval.test.ts`）。

- `tools/pre-execute` 的 waterfall 结果若是 `{kind:'ask'}`，宿主在链收敛后调用
  `ctx.get('approval')`；拿到服务就 `approval.request({ agent, toolName, callId, reason?, signal })`，
  拿不到（或 `exec.agent` 为空）就直接拒绝。**审批是宿主拥有的通道**，Jey 不再另建一套。
- 返回的 `ApprovalOutcome` 只有四个值，映射一对一：`allowed-once` → 放行；`rejected` /
  `unavailable` → 拒绝（原因不同）；`cancelled` → 拒绝并标记取消。组合了服务但没有终端应答者时，
  waterfall 的内层默认就是 `unavailable` —— fail-closed 由服务自己保证。
- `approval.request()` **要求有开着的 turn**，否则在写审计之前抛错；因此 Jey 只能在
  pre-execute 期间把它交回宿主，不能自己找时机发起。
- 结果对写进会话日志：`approval/asked{id, toolName, callId?, reason?}` 与
  `approval/decided{id, outcome}`，通过 `ctx.on('session/event', …)` 可观察（宿主持久事件通道，
  不是私有字段）。这是 Jey 唯一能把"人说了不"和"工具跑了但失败"分开的依据：
  `tools/result` 两种情况都是 `isError`。
- 会话策略 `ask` / `never`：`never` 在任何应答者之前把每次请求判为 `rejected`（无人值守的严格姿态）。
  Jey 不读这个策略，也不该读——它只负责把 `ask` 交出去并如实记录回来的结论。

对 Jey 的三条后果：

1. `capabilities().approvalChannel = ctx.get('approval') !== undefined` 必须真的驱动行为：
   没有通道时 `evaluatePolicy` 产出 `deny` 并附 `approval-channel-absent`，而不是交一个
   宿主必然替我们改成拒绝的 `ask`。限制相同，记录诚实度不同。
2. 执行行的状态因此可达五种：`succeeded` / `failed` / `denied-by-host`（人拒绝或通道不可用）/
   `cancelled` / `not-dispatched`（Jey 自己拒了，从未派发到）。
3. 拒绝仍来自未知来源时（沙箱、别的插件），`tools/result` 里读不出来，只能记 `failed`；
   这条限制写在 `jey-plugin.ts` 的注释里，不假装能区分。


## 15. 作用域、嵌套与次序（2026-09-27 实测）

来源同样是发布产物（`dsh-tools@0.1.7-alpha.1`、`dsh-scope@0.1.7-alpha.1`、
`dsh-system-prompt@0.1.7-alpha.1`）加上真实宿主测试里的执行结果。

**作用域与同名工具。** `ctx.tools.register(definition)` 没有"作用域版"签名：它按调用方的
上下文自行定位（`dsh-tools/lib/index.js:2882` → `ScopedLayers.effect` 用 `scopeOf(ctx)`）。
解析在 `ToolRuntime.view(scope)`：继承链"最远先写、最近的后写"，所以**最近的 scope 赢得同名**。
展示给模型的那一份（`systemPrompt.tools` → `wireSchemas(view.visible)`）与派发时解析的那一份
（`resolveExecution(name, exec.agent)` → 同一个 `view.visible`）是同一个视图，因此
"广告的定义"和"执行的定义"按作用域天然一致 —— Jey 的目录摘要也必须按作用域记，否则
A 的判定会被 B 的目录污染。

**可见性约束。** `ctx.tools.restrict({allow?, deny?})` 只在 agent 作用域可用（全局上下文调用
直接抛，`index.js:2893`），只能**收窄**：`admits()` 对 deny 命中或 allow 未命中返回 false，
层与层取交集。"被隐藏"在 `PromptAssembly.tools` 里的表现就是该 schema 不在数组里；
`knownNames` 仍保留全集，只用于配置校验。⇒ 一个下游插件没有办法把被宿主藏起来的工具加回来，
Jey 也从不尝试：它既不调 `register` 也不调 `restrict`（有测试计数）。

**目录变化的信号。** `tools/change` 是**零参数**、`@mode emit`、且刻意**不按作用域过滤**的
注册表广播（doc 原文："UNFILTERED registry-subject notification… a scoped listener subscribing
here sees every change, not just its own scope's"）。它不回答"谁的目录变了"，所以
"按作用域刷新摘要"只能落在 `system-prompt/assemble` 上：`AssembleContext.scope` 就是
`ScopeKey`（类型是 `object`，实测即 Agent 把手），从中读 `.id` 得到作用域键。

**嵌套派发。** `ToolExecutionInput` 带可选的 `rootCallId` 与 `parent`；PTC 桥正是这样构造子调用
（`index.js:1291-1306`：`subCallId = ${callId}:ptc:${n}`、`rootCallId: exec.rootCallId`、
`parent: exec.token`）。子调用走**完整管线**：pre-execute waterfall → 审批 → 同步 guard →
execute → post-execute → result。唯一的嵌套差异是 `meta`/presentation 只在
`exec.parent === void 0` 时附加，以及持久化事件名不同（`tool/ptc-dispatch*`）。
⇒ 一个根调用会产出**多条** `tools/result`，所以"这次派发发生了什么"必须按 `callId` 关联，
而"这次尝试算几次"仍按 `rootCallId`（见缺陷 34）。
⇒ 本机能做的嵌套验证是同一个注册表入口（`ctx.tools.execute` 带父 token）。真正的 PTC 桥
跑不起来：`@deepseek-ai/dsh-ptc-runtime@0.1.7-alpha.2` 只发布抽象 Service 定义，锁文件里没有
node 实现，`requirePtcRuntime` 直接抛。HOST-10 因此写 PARTIAL，而不是假装跑过桥。

**次序。** 注册顺序就是 waterfall 顺序。排在 Jey 之前的监听器如果**不调 `next()` 就返回拒绝**，
Jey 根本不会被问到：调用仍被拦住（权限没有被放宽），但 Jey 的日志里不会出现这条拒绝。
这是"多插件 waterfall 里的一环"的固有位置，不是一条能修的缺陷，因此以测试形式记录
（`is not consulted when a plugin mounted earlier refuses the call`）。
