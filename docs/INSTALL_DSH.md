# 在 DSH 里装载 Jev

基线：DSH `0.1.7-alpha.1`（提交 `c36a83f`）。本文只写实测过或官方文档写明的事实；没验的会直接标出来。

## 前置

- Node `^22.19.0 || >=24.0.0`（取自 DSH 包 `engines`；本仓库 CI 与本文的验证环境是 v24.15.0）。
- 一个能跑起来的 DSH。官方文档给的两条路（`README.md#run`）：

```sh
npx @deepseek-ai/dsh web          # 从 npm，默认 http://127.0.0.1:3080，加 --no-open 只打印地址
```

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build && pnpm dsh web    # 从源码
```

## 插件形态

DSH 插件是一个导出 `name` / `inject` / `apply(ctx, config)` 的模块，由 cordis 在装载时调用 `apply`。Jev 的入口在 `packages/adapter-dsh/src/jev-plugin.ts`，`inject` 只要 `tools`——审批通道是"有就用、没有就如实降级"，不作为硬依赖，这一点与宿主自身解析 `ask` 的做法一致。

## 装载（当前唯一可用方式：overlay）

在本仓库根目录建一个 profile 补丁文件，例如 `local/jey.cordis.yml`。`name` 必须是**绝对路径**（官方 `docs/user/develop/basic/index.md` 明确要求；补丁文件本身不会改变解析相对路径的 profile 目录）：

```yaml
- insert:
    - id: jey
      name: 'D:/codeWork/jev-dsh/repo/packages/adapter-dsh/src/jev-plugin.ts'
      config:
        schemaVersion: '1'
        mode: off
        provider:
          kind: unconfigured
        egress:
          mode: deny
        limits: {}
        features: {}
        audit: {}
```

`config:` 块的形状就是 `config/config.schema.json`；`{}` 会让 schema 里的默认值填进来。上例是全关的最小可用配置：装上之后 Jev 不做任何事，`doctor` 之外也没有可观察行为。想开始观察再改：

```yaml
        mode: shadow
        provider:
          kind: mock          # 合成应答，只用于工程验证
        features:
          toolAssessment: true
```

**注意 `mode: enforce` + `provider.kind: mock` 会被直接拒绝装载**，报 `ENFORCE_WITH_MOCK`。这不是运行期降级，是 `apply` 阶段抛错、`ctx.plugin()` 随之失败——已有宿主测试钉住这条。

`provider.kind: local` 与 `typesafe` 现在都是真实现：前者连本机 `python/local_decider` 服务，后者连云端提供方。**Jev 自己不启动、不重启、不下载任何东西**——服务不在就是 `LOCAL_NOT_READY`，策略层按"必需检查不可用"升级，不会静默退回 mock。

## 接上本地提供方

先把服务跑起来（约 3.01 GB 权重，需单独授权执行；细节见 `python/README.md`）：

```sh
cd python && uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe -e "<SemIf 固定检出>[llamacpp]"
.venv/Scripts/python.exe -m local_decider.download_weights          # 下载并按 models.lock.json 校验 sha256
JEY_LOCAL_TOKEN="$(openssl rand -hex 24)" .venv/Scripts/python.exe -m local_decider.service --port 8732
```

然后 overlay 里：

```yaml
        mode: enforce
        provider:
          kind: local
          local:
            endpoint: 'http://127.0.0.1:8732'
            tokenRef: 'env:JEY_LOCAL_TOKEN'      # 引用，不是令牌本身
            ownership: external
            expectedModel:
              requested: bartowski/Qwen_Qwen3.5-4B-GGUF
              revision: 4168f45a16a1290d65a4ec0fa312ae917a4c15d6
              weightsDigest: 'sha256:13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983'
              tokenizerRevision: 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a
              quantization: Q4_K_M
        egress:
          mode: local-only
          allowedOrigins: ['http://127.0.0.1:8732']
          allowedPurposes: ['tool-assessment']
        limits:
          deadlineMs: 60000        # 见下：默认 1500 是云端量级
        features:
          toolAssessment: true
```

这份配置是**跑过 `loadConfig` 验证**的，不是照抄 schema；同样的内容以机器可读形式放在 `config/examples/off-minimal.json` 与 `config/examples/local-enforce.json`，`packages/core/test/unit/config-examples.test.ts` 会逐个装载它们并把 `expectedModel` 对着 `python/models.lock.json` 核对，所以示例不会和锁、也不会和 schema 悄悄分叉。几个会当场拒掉的写法：

| 写法 | 结果 |
|---|---|
| `egress.mode: local-only` 而不给 `allowedOrigins` | `LOCAL_ONLY_NEEDS_ORIGIN`（一个永远到不了服务、却写着"只走本地"的配置没有意义） |
| `allowedOrigins: ['http://localhost:8732']` | `LOCAL_ONLY_REJECTS_CLOUD_ORIGIN: http://localhost:8732 is not loopback` |
| `limits: {}` | 装载成功，但 `deadlineMs` 取默认 **1500** |
| 服务的权重和 `expectedModel` 不一致 | 装载成功、**第一次决策前**就失败：`ExpectedProvider` 先探 `capabilities()`，逐字段比对后才肯发第一个请求；不匹配是 `UNSUPPORTED_CAPABILITY` 且不可重试。探测不带任何任务状态，所以发错的代价不是内容外泄 |

`deadlineMs` 那条是实测出来的：CPU 上加载权重约 19 s（一次性），三条固定执行门问题冷状态 **2.48 s**、命中状态前缀缓存后每问约 0.5 s（`artifacts/local_inference_e2e.json`）。1500 ms 是云端提供方的量级，本地提供方不抬高就会每次 enforce 都 `TIMEOUT` 失败关闭。服务端也把自己能接受的时限钉在 60000 ms，与 schema 的 `limits.deadlineMs.maximum` 一致——配置只能收紧，不能放宽。


启动时把补丁文件交给 DSH：

```sh
dsh --profile <你的 profile> web        # profile 位于 $DSH_HOME/profiles
dsh plugin --profile <profile> add <包名>   # 官方 CLI，把参数转发给 profile 目录里的 pnpm
```

## 确认它真的在跑

Jev 默认把审计写到 stderr；设了 `JEY_AUDIT_PATH` 就改写成 JSON Lines 文件（路径只来自环境变量，绝不来自模型可见的配置，也不接受模型改 `audit.rawContent`）：

```sh
JEY_AUDIT_PATH=/tmp/jey.jsonl dsh --profile web --no-open
```

然后在会话里让它调一次工具，再看：

```sh
tail -n 3 /tmp/jey.jsonl
```

第一行是装载行（`kind: diagnostic`，`reason` 以 `mounted:` 开头）——**没有它就等于 Jev 不在**，
后面才是判定。每做一次判定写一行 `decision`，紧跟一行 `execution`。值得核对的三点：`action` 是 Jev 的判断、`hostDecision` 是宿主原本的决定、`execution` 是实际发生了什么——**没执行就是 `null`**，不会出现"模型答了"被写成"工具跑了"。`synthetic: true` 表示这次应答来自 mock，不是真实模型。

`packages/adapter-dsh/test/host/plugin-entry.test.ts` 走的正是这条路径：真实的 `ctx.plugin(jeyPlugin, config)`、不注入 provider、不注入 sink、断言落盘的行能被恢复扫描器原样读回。

## 装载证据与一个必须知道的例外（HOST-01，2026-09-27 实测）

上面那条链已在**固定版真实 launcher** 上跑通：`scripts/host_boot_check.mjs` 建一个临时 `DSH_HOME`、
`npm install @deepseek-ai/dsh@0.1.7-alpha.1`、用 `--patch` 叠加层装载 `packages/adapter-dsh/dist/`
里的构建产物，然后检查三件事 —— `--dump-config` 是否组合出我们的条目、坏配置是否由**我们**拒绝、
`off`/`shadow` 是否真能起来。全程不读写 `~/.dsh`，日志落盘前抹掉 `token=`。

```sh
pnpm -r build
node scripts/host_boot_check.mjs --dsh 0.1.7-alpha.1 --home ../.work/dsh-host
```

必须知道的例外：**配置被拒不代表宿主起不来。** `0.1.7-alpha.1` 的 `boot()` 只对它自己内置的
`requiredStartupEntryIds` 判死，第三方插件抛错会被归为"未激活条目"，输出

```
dsh: warning: 1 entry did not activate
jey (file:///…/jev-plugin.js): ConfigError: invalid Jev configuration: ENFORCE_WITH_MOCK@/provider/kind
dsh web: http://127.0.0.1:<port>/?token=…
```

然后照常服务（退出码 0）。同一份配置在 `0.1.5-rc.2` 上会中止启动，所以这不是"一直如此"的行为，
而是固定版上的行为。也就是说：**一个配了 enforce 但配置写错的部署，运行的是没有 Jev 的宿主**，
而第三方插件没有办法把自己的激活变成必需。

可操作的核对方式是看审计：装载成功一定会先写一行

```json
{"kind":"diagnostic","reason":"mounted:mode=enforce provider=local egress=local-only", …}
```

启动后该文件为空或不存在 = Jev 不在。这一行不能由宿主日志替代：启动期的日志 exporter 是
`levels:{default:2}`（warn 及以上），插件的 info 行在那段时间根本不会被打印。

## 卸载

从 overlay 里删掉那个 `id: jey` 条目并重启即可。Jev 只注册监听器和一个同步 guard，`apply` 的清理会把它们逐个注销；插件实例被换掉时 generation 递增，此前在途的判断全部作废，不会跨实例生效。

## 审批通道：发行版默认就有

`@deepseek-ai/dsh-base` 自己的 `cordis.patch.yml` 里就组合了 `id: approval` 的
`@deepseek-ai/dsh-user-approval`（web/acp/headless/sdk 四个模板都建在 base 上），所以 Jev 交回的
`ask` 在真实发行版里会走到 UI 应答者，不需要额外装载。要确认：

```sh
dsh --profile web --dump-config | grep -n "id: approval"
```

三条实测行为（`docs/HOST_CONTRACT.md` §14、§15）：

- **要让 Jev 真的提问，两侧都得成立**：宿主组合了审批服务，且配置里
  `features.approvalRequests: true`。只满足前者以前照样会弹窗——那个开关当时只在装载阶段
  被检查一次，运行期没人读它。现在缺任何一侧，升级都会降级为拒绝。
- 没有审批服务、或者那次调用没有 agent 时，Jev 把该次判定直接记成 `deny` 并附
  `approval-channel-absent`。限制效果与宿主替我们降级相同，但记录说清了是谁拒的。
- 会话策略 `never`（无人值守姿态）由服务在任何应答者之前把每次请求判为 `rejected`。
  Jev 既不读也不改这个策略——它只负责把问题交出去，并如实记录回来的结论。

## status / doctor：装载状态的可核对入口

上一节说 launcher 在配置被拒时只 warning 后继续 serve，所以需要一条**只读**命令来回答"这个部署里的 Jev 到底在不在、以什么模式在"。它读三样东西，不写任何东西、不启动任何东西、不发任务状态：

```sh
# 相对路径按当前工作目录解析；从仓库根这样跑最省心
node packages/adapter-dsh/src/doctor-cli.ts \
  --config config/examples/off-minimal.json \
  --journal ../.work/dsh-017/home/off-audit.jsonl \
  --dsh-home ../.work/dsh-017/home
# 等价：pnpm --filter jev-adapter-dsh run doctor -- --config …（此时 cwd 是包目录）
```

真实一次运行的输出（本机 `~/.dsh` 装的是 rc.2，配置指向未运行的本地评分服务）：

```
verdict      NOT_READY
launcher     MISMATCH pinned 0.1.7-alpha.1 / installed 0.1.5-rc.2
approval     true — ask 会送进宿主的审批接缝，结论从 approval/asked + approval/decided 事件对读回
inference    UNAVAILABLE — 探测失败
credential   env:JEY_LOCAL_TOKEN = NOT_CONFIGURED
journal      absent mounted=false decisions=0 isolated=0
why          launcher-mismatch:0.1.5-rc.2!=0.1.7-alpha.1
why          provider-unreachable:no local service token resolved for /v1/capabilities; refusing an unauthenticated request
why          journal-absent:没有可读的审计文件，装载状态无从判断
```

两条它刻意做到的事：

- **版本不匹配不写成兼容**（也相反：读不到就报 `UNKNOWN`，不替安装位置背书）。固定合同是
  `0.1.7-alpha.1`，本机装的是 `0.1.5-rc.2`，两者在"装载失败要不要中止"上行为不同，
  所以 doctor 直接把 `MISMATCH` 判成 `NOT_READY`。
- **凭据只显示 `已配置/未配置`**，值和环境都不进报告；这条有测试盯着（把值塞进
  `JSON.stringify(report)` 里就会出现的那条断言会红）。云端提供方的能力探测一律
  `NOT_RUN`：doctor 不发需要授权和花钱的请求。
- **装载状态取自审计本身**。没有 mount 行就写 `journal-unmounted`，即使配置文件完全合法。
  看门狗可以只看这一条：`grep -c '"reason":"mounted:' "$JEY_AUDIT_PATH"`。

## 还没实现 / 没验证

| 项 | 状态 |
|---|---|
| `status` / `doctor` 只读命令 | **已实现**（见上一节）。它报告配置、宿主观测、提供方探测与审计计数；不做的是"活进程健康检查"——Jev 是库，没有控制端口 |
| 已发布的 npm 插件包 | **不存在**，`jey-*` 尚未发布，也没有确认过名称可用性 |
| Windows 原生 / WSL2 / Linux / macOS 分别验证 | 只在 **Windows 原生 + Node 24.15** 实测过。`python/.venv` 与 llama.cpp 的 CPU 路线同理，Linux/macOS 路径未跑 |
| 本地提供方 | 服务、真实权重、真实 TS 客户端**已跑通**（见 `docs/STATUS.md` M3）；`pip install python/` 这条路没走过，实测方式是仓库内 `.venv` + `-m local_decider.service` |
| 断外网下的"严格离线" | **未验证**。只验证到代码路径不取网（`HF_HUB_OFFLINE=1` + `local_files_only` + 请求期不下载）；没做断网抓包级验证，所以不写"严格离线" |
| `expectedModel` 逐字段比对 | 核心逻辑有单测（含"不匹配时提供方调用数为 0"），字段**取值**在端到端里对着 `models.lock.json` 核过；两者之间没有真机 mismatch 演练 |
| `ask` 真正弹审批 | **PARTIAL**：真实服务已组合并有测试（授予/拒绝/无人应答，见 `approval.test.ts`），但应答者是测试里注册的合成监听器；人在浏览器里点下按钮那条端到端路径没跑过 |
| "Jev 装载失败就不许启动" | **宿主不提供**。`0.1.7-alpha.1` 对第三方条目只 warning 后继续 serve，`requiredStartupEntryIds` 是它自己内置的清单，没有对外开关。要这条保证只能靠外部核对（见上一节的 mount 行） |
| `presentationFilter`（收窄模型可见工具） | **默认关闭**，且宿主合同 §8.2 的时序 gate 未通过前不应打开 |

## Linux reconstruction and packaged install (2026-09-30)

See [the fresh verification report](RECONSTRUCTION_20260930_LINUX.md). Local examples
use a bounded 60000 ms budget because CPU latency varies; the earlier cloud run
exceeded the old 10000 ms example. The launcher has caret-ranged host dependencies,
so pinning its version alone does not freeze the full runtime; host receipts now
include actual resolved versions.

A rejected third-party plugin can leave the host serving without Jev. Require a
fresh per-launch audit, a mount matching mode/provider/egress, and a successful
readiness check before admitting work. An external supervisor must stop the host
when this fails; doctor does not supervise processes or prove liveness from old logs.

The schema and model-lock package copies are checked against their source contracts.
For a Python wheel, pass an explicit writable data directory via `--repo-root` to
both downloader and service. No default writes are made inside site-packages.
