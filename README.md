# Jev for DSH

Jev 是一个嵌进现有 Agent 的**可替换模型的结构化决策层**。它不接管宿主的规划、生成或授权体系，只在明确的节点上给出观测：这次工具调用是否推进当前目标、证据是否充分、是否与已声明的限制冲突。

设计代号 **ADL**（Agent Decision Layer）来自技术交接包；对外的产品与包名以本仓库为准，即 `jev-*`。

项目名为 **jev-dsh**。参见 [Jev 模型支持](docs/JEV_MODEL_SUPPORT.md)、[命名兼容](docs/NAMING_MIGRATION.md) 与 [本轮重新验证](docs/RECONSTRUCTION_20260930_LINUX.md)。

## 现在能用什么

**还不能当作发行版安装**（`jev-*` 未发布）。装载方式见 [`docs/INSTALL_DSH.md`](docs/INSTALL_DSH.md)。

一句话状态：**具备真实本地推理能力的开发原型**。决策核心与宿主接线都能跑，独立核查（`docs/IMPLEMENTATION_REVIEW_20260927.md`）发现的 7 项宿主保护逻辑缺陷（P0-01～P0-07）已逐项修复并补上回归测试；构建产物也已在固定版真实 launcher 上装载核实（HOST-01）。MCP 服务已可作为独立 stdio 进程运行（`docs/INSTALL_MCP.md`，`mcp-contract` 5 条已用真实客户端与真实子进程核实），但公开发行、安全验收与模型质量评测都还没做；源码外安装与打包检查的范围见本轮验证报告。审批通道已在真实 `dsh-user-approval` 上验证过授予/拒绝/无人应答三条路径，唯独"人在浏览器里点下按钮"那一段没跑。

因此不写"M0–M2 gate 已全部通过"这种话：工程 gate 绿过，只说明**已写下的测试**通过。逐条状态看这两份：

| 文件 | 回答的问题 |
|---|---|
| `docs/GATE_CASES.md` | 交接包 74 条验收案例里，每条现在是什么状态、由哪条具名测试或哪次真实运行支撑 |
| `docs/STATUS.md` | 每个 gate 的执行命令、结果、以及"没跑"和"跑不过是两回事" |

```sh
pnpm install
pnpm -r build && pnpm -r typecheck     # 类型合同
pnpm --filter jev-core test            # 161 条单元
pnpm --filter jev-core test:property   # 17 条属性
pnpm --filter jev-adapter-dsh test     # 75 条：真实 agent loop 上的宿主闭环、审批通道、装载入口、doctor、外发与审计
pnpm --filter jev-adapter-mcp test     # 28 条：真实 stdio 子进程 + 官方 SDK 客户端的握手/列表/调用、stdout 纯净、两类错误、取消与断连
pnpm --filter jev-provider-typesafe test  # 23 条：云端线格式契约，夹具来自官方文档，全程不联网
pnpm --filter jev-provider-local test     # 17 条：本地评分服务客户端契约（只认字面 loopback 等）
pnpm --filter jev-provider-mock test      # 5 条：合成提供方必须永远自报合成
(cd python && python -m unittest discover -s tests -t .)
                                         # 70 条：64 条无需模型；6 条真实推理需显式启用，默认 skip
node scripts/host_boot_check.mjs --dsh 0.1.7-alpha.1 --home ../.work/dsh-host
                                         # 真 launcher 装载核实：临时 DSH_HOME + npm 安装 + --patch 构建产物，不碰 ~/.dsh
node packages/adapter-dsh/src/doctor-cli.ts --config config/examples/off-minimal.json
                                         # 只读 status/doctor：配置、宿主观测、提供方探测、审计计数
                                         # 本机 ~/.dsh 装的是 rc.2，这条会以退出码 1 报 MISMATCH/NOT_READY——那正是它的作用
node scripts/mcp_stdio_transcript.mjs  # 重生成 artifacts/mcp_stdio_session.json：一次真实 stdio 会话的原样字节
```

## 三条不可妥协的约束

1. **不增加权限**：模型说“没问题”只是不额外限制，永不取消宿主已有的 deny/ask/沙箱。
2. **不伪造有效性**：Mock、回放、真实推理分开记录；跳过不等于通过。
3. **不静默外传**：默认 `egress.mode=deny`。安装在本机、shadow 模式、本地 HTTP 代理都不等于离线推理。

## 读什么

| 文件 | 内容 |
|---|---|
| `docs/HOST_CONTRACT.md` | M0 实测的 DSH 宿主合同：真实扩展点签名、生命周期顺序、schema 子集 |
| `docs/STATUS.md` | gate 状态矩阵 |
| `docs/handoff/` | 技术交接包原件（哈希核验后复原，非本项目实现） |
| `packages/contracts` | 公共边界类型，不 import DSH |
| `packages/core` | 纯策略、外发策略、边界校验，无 I/O、无网络 |

基线固定为 DSH `0.1.7-alpha.1`（`c36a83f`），不是“永远最新”。

## 自动检查

GitHub Actions 会运行冻结依赖安装、全部 TypeScript 构建/类型检查/测试/属性测试、
源码外 npm 安装与派发检查，以及 Python 协议测试和 wheel 打包检查。
CI 不读取模型凭据，不下载权重，也不调用收费 API；6 条真实推理测试明确跳过，
真实本地 E2E、launcher/HMR 和完整模型验收见注明日期的独立报告。
