# 以 MCP 服务运行 Jey

本文对应的实现是 `packages/adapter-mcp`，验收案例是交接包 `contracts/test-matrix.csv` 的 `mcp-contract` 5 条与规范 §12。文中每条"已经过"都指到一个具名测试或一次真实运行；做过的与没做的分开写。

## 这是什么，不是什么

Jey 通过 stdio 暴露**三个判断工具**，供任何 MCP 客户端调用。规范 §12 的原话是"MCP 是能力暴露，不是对所有 Agent 的透明拦截"，所以：

| 它做 | 它不做 |
|---|---|
| 回答"这条论断在这段证据下成立吗"、"这几个互斥选项选哪个"、"这些候选各自打几分" | 执行任何动作；没有 `jey_execute`，也没有 `jey_set_policy`（规范明确禁止） |
| 把判断连同**答题者身份**（提供方 kind、resolvedModel、`synthetic`）一起返回 | 拦截或改写客户端自己的权限、沙箱、审批 |
| 在第一个字节发出之前检查 egress 与额度 | 写审计 journal——这条路目前没有 journal，见"已知边界" |
| 客户端取消时中止自己发往提供方的请求 | 自动换模型、重试、或按"环境里恰好有个 key"切到云端 |

一个 MCP 客户端不是一台 DSH。装载期用的 `HostCapabilities` 因此三项全 `false`（`src/main.ts` 的 `MCP_HOST_CAPABILITIES`）：没有审批通道、没有可收窄的工具可见性、没有执行后瀑布。配置里要是打开 `approvalRequests` 或 `presentationFilter`，`loadConfig` 直接拒绝启动，而不是"声明了但没人执行"。

## 前置

- Node `^22.19.0 || >=24.0.0`。本文与测试环境是 v24.15.0，测试直接跑 TS 源（Node 的类型剥离），不需要先 build。
- 本仓库依赖装好：`pnpm install`。
- 包本身**没有发布到 npm**（P1-04 未做）。所以下面两种起法都是从仓库里跑；`bin` 名 `jey-mcp` 已经声明在 `packages/adapter-mcp/package.json`，装成 tarball 之后就是同一条命令。

## 起服务

```sh
node packages/adapter-mcp/dist/main.js --config <一份 Jey 配置>   # 构建产物，等同 bin
node packages/adapter-mcp/src/main.ts --config <同一份配置>       # 从源跑，测试用的就是这条
```

`--config` 缺省时读 `JEY_CONFIG` 环境变量；两者都没有就报错退出。配置文件的形状与 DSH 插件完全一样（`config/config.schema.json`），因为走的是同一个 `loadConfig`。最小可跑的两份例子已经作为可执行文件入库：`config/examples/mcp-mock-shadow.json`（无模型、无网络）与 `config/examples/mcp-shadow-local.json`（连本机 `local_decider`）。它们和 `off-minimal.json`、`local-enforce.json` 一起被 `packages/core/test/unit/config-examples.test.ts` 过一遍真 `loadConfig`，并被 `packages/adapter-mcp/test/unit/provider.test.ts` 真的构造出提供方。形状长这样：

```json
{ "schemaVersion": "1", "mode": "shadow",
  "provider": { "kind": "mock" },
  "egress": { "mode": "deny" },
  "limits": { "deadlineMs": 3000 }, "features": {}, "audit": {} }
```

```json
{ "schemaVersion": "1", "mode": "shadow",
  "provider": { "kind": "local", "local": {
      "endpoint": "http://127.0.0.1:8732", "tokenRef": "env:JEY_LOCAL_TOKEN",
      "ownership": "external",
      "expectedModel": { "requested": "bartowski/Qwen_Qwen3.5-4B-GGUF", "revision": "4168f45a…" } } },
  "egress": { "mode": "local-only", "allowedOrigins": ["http://127.0.0.1:8732"],
              "allowedPurposes": ["evidence-check", "explicit-query", "tool-relevance"] },
  "limits": { "deadlineMs": 10000, "maxConcurrent": 1 }, "features": {}, "audit": {} }
```

要点，都是被测试钉住的：

- **`endpoint` 写的是服务的 origin**，不带路径：客户端自己拼 `/v1/capabilities` 与 `/v1/decide`。写成 `…/v1/decide` 会让能力探测打到 `/v1/decide/v1/capabilities`，得到一个 404 伪装成"这个模型不支持这类问题"。这条在 `test/unit/tools.test.ts` 的注释里也写了，因为它一开始就是把测试自己骗过去的坑。
- **`provider.kind: typesafe` 在这里被拒绝启动**，报错指向本文（`src/provider.ts`）。云端这条路在本仓库仍是 `BLOCKED`（无凭据、无预算），而一个常驻的 stdio 进程从环境里读出 key、开始外发状态，正是规范 §12 禁止的那种"发现了就切过去"。
- **`ownership: managed` 被拒绝**：Jey 从不启动、重启、下载推理服务。先把 `python/local_decider` 自己跑起来，再用 `external`。
- `mode: enforce` + `provider.kind: mock` 依旧在装载期拒绝（`ENFORCE_WITH_MOCK`）。
- 凭据只写引用（`env:` / `file:`）。`keystore:` 在 MCP 这条路明确报不支持——它没有钥匙串会话可用。

## 客户端注册

以支持 stdio 的客户端为例（各家的字段名不同，语义相同）：

```json
{
  "mcpServers": {
    "jey": {
      "command": "node",
      "args": ["D:/codeWork/jev-dsh/repo/packages/adapter-mcp/dist/main.js",
               "--config", "D:/codeWork/jev-dsh/repo/local/jey.mcp.json"],
      "env": { "JEY_LOCAL_TOKEN": "……服务自己的随机令牌" }
    }
  }
}
```

`JEY_LOCAL_TOKEN` 只出现在子进程环境里；它既不进配置，也不出现在 stdout/stderr——`MCP-02` 那条测试就是拿一个真实 token 断这两点的。

## 三个工具

`tools/list` 发布的 `inputSchema` 与处理调用时编译的 schema 是**同一个对象**（`src/schema.ts` 是唯一来源，`test/unit/schema.test.ts` 有一条断言"发布的那份就是校验的那份"）。交接包 §12 里叫 `adl_check`/`adl_choose`/`adl_rank`，本仓库发的是 `jey_check`/`jey_choose`/`jey_rank`，映射写在 `LEGACY_TOOL_NAMES` 里并有测试覆盖。

| 工具 | 输入 | 输出（`structuredContent`） |
|---|---|---|
| `jey_check` | `claim`、`evidence` | `kind:'boolean'`、`pYes`、`probability{origin,calibration,calibrationId}`、`abstained`、`provider{kind,resolvedModel,synthetic}` |
| `jey_choose` | `instruction`、`options[2..16]{id,description}`、可选 `context` | `selected`（没有合适项时是 `none-applicable`）、完整 `probabilities`、`abstained` |
| `jey_rank` | `instruction`、`candidates[0..32]{id,text}`、可选 `levels` | 每个候选的 `expectedIndex`（Σ 索引×概率，允许小数；没答案时是 `null`）与 `ordering`；`noneApplicable` |

三份 schema 都 `additionalProperties: false`，并且**没有**任何字段能装下 sessionId、host-attested 标志、endpoint、模型路径、key 引用或策略模式。每个工具的 `purpose` 由工具本身固定（`evidence-check` / `explicit-query` / `tool-relevance`），调用方不能挑一个来绕开按 purpose 的 egress 规则。三个工具都带 `annotations.readOnlyHint: true`、`openWorldHint: false`。

`candidates: []` 是一次合法请求：返回 `noneApplicable: true`、`abstained: false`、`provider.resolvedModel: "not-called"`，**不发往任何提供方**。"没东西可问"既不是失败也不是模型弃权，这三件事在返回里有三种写法。

## 错误语义

两件事严格分开（`MCP-03`）：

- **协议错误** → JSON-RPC error，没有 result：未知工具是 `-32601`，参数不合发布的 schema 是 `-32602`（消息里带上具体缺哪个字段）。客户端看到这两类不该重试。
- **判断没做成** → 正常 result 带 `isError: true`，文本是一个 JSON 对象 `{"error":{"code":…,"retryable":…,"message":…}}`。`code` 保留答题方给出的名字（`LOCAL_NOT_READY`、`UNSUPPORTED_CAPABILITY`、`INSUFFICIENT_CONTEXT`、`EGRESS_DENIED`…），不塌成 `INVALID_RESPONSE`。`retryable` **不是**本适配器的猜测：提供方在服务端分类里已经声明过一次（429 可重试、504 不可重试），协调器把它随 code 一起带出来，这里原样转发。`test/unit/tools.test.ts` 用真实 HTTP 监听分别拿 429/503/422/504 四种答案钉住这条。

成功的回答里 `content[0].text` 与 `structuredContent` 是**同一串字节**（`JSON.stringify` 的结果），不是换一种说法的摘要，所以读不到结构化结果的客户端不会读到另一个答案。

## 外发、额度与取消

- 每次调用都过 `checkEgress`（与 DSH 适配器同一个函数、同一份配置语义），在提供方被问之前。`egress.mode: deny` 下返回 `EGRESS_DENIED`，且测试断言提供方的调用计数仍为 0。
- 额度由 `DecisionCoordinator` 按 `limits` 执行：并发、队列、`deadlineMs`（含排队时间）、每回合与每会话次数、同一 session 的排队上限。
- 客户端取消（SDK 的 `signal`，或 `notifications/cancelled`）会中止 Jey 发往提供方的那个 HTTP 请求。`MCP-05` 是端到端证明：本地服务先把连接吊住不收口，测试观察到它自己的 socket 被对端挂断，然后第二次调用必须在同一个 `maxConcurrent: 1` 的服务下真的跑到提供方（拿到 `LOCAL_NOT_READY` 而不是排队饿死）。这一条对旧代码会变红——把 `signal` 换成一个永不中止的控制器它就不过。
- 客户端把 stdin 关掉之后，服务进程以 **exit code 0** 退出（`MCP-02` 断言）。这一点在"调用还在途"时同样成立：`MCP-05b` 让本地服务把连接吊住不收口、客户端直接消失，进程仍要在 4 秒内自己退掉——旧代码做不到（协调器 close 之前没人注意到客户端走了，进程被那条未完成的 HTTP 请求吊着），这也是 `src/main.ts` 里那行 `process.stdin.once('end', …)` 存在的原因。stdout 上每一行都得是 JSON-RPC 帧，日志只去 stderr。

## 一次真实会话（证据）

`artifacts/mcp_stdio_session.json` 是一次真实 stdio 会话的原样记录，由 `node scripts/mcp_stdio_transcript.mjs` 重新生成（临时配置路径已改写）。`initialize` → `notifications/initialized` → `tools/list` → 一次成功的 `jey_check` → 一次缺 `evidence` 的调用 → 一次未知工具。里面可直接核对的几点：

- stdout 恰好 5 帧，全部是 JSON-RPC；stderr 两行：`jey-mcp: listening on stdio (mode=shadow provider=mock egress=deny)` 和收尾的 `jey-mcp: stdin ended; closing the coordinator and exiting`；
- 成功那次的答案带 `"provider":{"kind":"mock","resolvedModel":"mock-static","synthetic":true}`；
- 缺参数那次是 `{"error":{"code":-32602,...}}`，未知工具那次是 `-32601`；
- `exitCodeAfterClientDisconnected: 0`。

## 已知边界（没做的就写没做）

1. **没有审计 journal。** DSH 那条路每条判定与每次执行都会落 JSONL 行；MCP 这条路目前只在 stderr 写诊断。规范 §12 没有给 MCP 规定 journal，但"有效性证据"这件事因此只在 DSH 侧成立——不要把 MCP 的返回当成审计记录。
2. **没有 doctor。** 只读诊断命令（`packages/adapter-dsh/src/doctor-cli.ts`）读的是 DSH 的 home 与 launcher 版本，对 MCP 客户端没有对应物；MCP 侧唯一的启动期检查就是 `loadConfig` 拒绝矛盾配置。
3. **一个进程一个身份。** 快照身份固定是 `sessionId: 'mcp'`、`agentId: 'mcp'`（`src/tools.ts` 的 `factsFor`），因此 `perSessionCalls` 是**整个服务进程**的额度，不是每个客户端一份。多客户端共用一个 jey-mcp 时这会是先耗尽的那条限制。
4. **schema 是手写的单源，不是从 `jey-contracts` 生成的。** 规范 §12 要求"inputSchema、outputSchema 与核心契约同源生成"；现在满足的是"发布的那份就是校验的那份"（有测试），以及输出 schema 必须带 `provider{kind,resolvedModel,synthetic}` 与 `abstained`（有测试）。类型→JSON Schema 的生成器还没有，这一条记在 `docs/STATUS.md`。
5. **Claude Code / OpenCode 那类原生 hooks 适配是后续任务。** 这里跑通的是"独立 MCP 客户端能握手、列表、调用"，不是那些宿主的自动接入。
6. **云端提供方未接线**（`BLOCKED`，无 key 无预算）。

## 怎么复核

```sh
pnpm --filter jey-adapter-mcp test        # 27 条：19 单元 + 8 条真实 stdio 契约
pnpm --filter jey-adapter-mcp typecheck
```

契约测试会 spawn 真实子进程、用官方 `@modelcontextprotocol/sdk` 的 `Client` 走 stdio，并在测试进程里起一个真实 HTTP 监听冒充本地推理服务。没有 mock 传输层。
