# Agent Kernel Bake-off 结果

**PRIMARY：AI SDK。SECONDARY：Pi。NOT RECOMMENDED FOR CORE：Mastra。**

范围是 ReproPath 的默认内嵌 Agent Kernel。三者都完成相同 Mock Gateway 验收；排序依据控制适配成本、依赖与实测启动开销，不代表 Mastra 的平台能力或 Pi 的交互式产品能力较差。没有修改现有产品行为，没有开始正式 M2。

## 环境与结果

2026-09-08，Windows x64，Intel Core Ultra 5 125H，Node **24.6.0**，pnpm **10.17.1**。基线 `8cddb86`，实验为独立 workspace，固定直接依赖并提交独立 lockfile。已有 5177 开发服务保留；实验只使用临时 localhost 端口，不读取浏览器 cookie。

| 验证 | 结果 | 证据 |
|---|---|---|
| 三个候选统一验收 + SDK 专项 | **59/59 PASS**，无 skip | [tests.tap](results/tests.tap)，含 3 个父测试、54 个候选子测试、2 个专项测试 |
| 实验 TypeScript | PASS | [verification.json](results/verification.json) |
| 可选真实模型 | **SKIP**：缺少完整环境配置 | `src/real.ts`；不能据 FakeModel 推断所有真实服务兼容 |
| 既有 M1.1–M1.5 | `pnpm typecheck` PASS；`pnpm test` **64/64 PASS**；`pnpm build` PASS | [verification.json](results/verification.json) |
| 性能 | 每候选 10 次冷启动、100 次四步循环全部完成 | [330 个原始样本](results/benchmark.json) |

## 公平比较与架构

```text
相同中文 Goal + 相同 OpenAI-compatible FakeModel HTTP/SSE
                       ↓
         候选原生 Agent loop（负责每次模型迭代）
                       ↓
     同一 RunHost policy：budget / timeout / one-tool fence
                       ↓
       同一 Zod source → 同一 AgentToolGateway
                       ↓
       deterministic Mock：observe → click → observe → finish
```

[RunHost](src/common/host.ts) 不调用模型、不实现迭代循环。AI SDK 使用 `ToolLoopAgent`，Pi 使用 `Agent.prompt`，Mastra 使用 `Agent.stream`。三个候选均通过 SDK provider 访问同一个本地假 endpoint；不是手工执行固定四步后宣称 SDK 通过。FakeModel 只决定模型响应，工具由各 SDK 实际分派执行。

`src/common/types.ts` 是可替换内核的边界；[MockGateway](src/common/gateway.ts) 共用初始 E1/E2/E3，点击 E3 后返回登录服务异常和 high `HTTP_5XX`，每次 observe 产生单调 ID。旧 ID 返回可恢复的 `STALE_OBSERVATION`，不抛致命错误。

业务路径与 MCP 路径是两组独立场景：业务仍只暴露三个 Gateway 工具；MCP 场景只给模型 `echo`。没有把 MCP 变成浏览器执行后门。

## 验收矩阵

以下各项对 AI SDK / Pi / Mastra **均 PASS**，测试名可直接在 [kernel.test.ts](tests/kernel.test.ts) 和 TAP 中定位。

| 测试名 | 断言 |
|---|---|
| normal / observation / events | 严格 observe、click、observe、finish；后续模型输入含 HTTP_5XX；四次 tool-result，首尾 run 事件 |
| stream message | 原生流式文字归一成 `message`，包括 Unicode |
| invalid schema | `123` / `null` 参数被拒绝，Gateway 收到 0 次调用 |
| unknown tool | `delete_database` → UNKNOWN_TOOL，不猜工具、不执行 |
| one tool per turn | 同一响应两个 observe，Gateway 最多执行一次 |
| parallel click click finish blocked | 同一响应两个 click 和 finish，只有一次 click 分派，finish 为零 |
| stale recovery | 旧 obs-1 失败结果确实出现在下一次模型请求，重新 observe 后正常结束 |
| budget 10 | 模型还想继续也只请求 10 次，`budget_exhausted` |
| 20 steps bounded context | 20 个模型轮次，准备上下文 ≤6 条，最终 wire messages ≤7 条，旧 obs-1 结果已移除 |
| model protocol error | 无有效 completion 的响应 → MODEL_PROTOCOL_ERROR |
| tool execution error | Mock click 抛错 → TOOL_EXECUTION_ERROR |
| timeout 500ms | 等待 2 秒的模型在 500 ms run timeout 后返回 RUN_TIMEOUT；整体 <1000 ms |
| plain abort | 普通 AbortController 返回 aborted / ABORTED，<1000 ms，零工具调用 |
| takeover model / resume | 模型等待时接管 → paused_by_human，abort 后返回 <1000 ms；旧 ID 无效，新 run 成功 |
| takeover tool / resume | 延迟 click 时接管；超过工具延迟后 clickCount 仍为零；新 run fresh observe 后成功 |
| MCP allowlist echo error=false | 实际 server echoCount=1，模型工具列表恰为 echo |
| MCP allowlist echo error=true | MCP isError/SDK throw → MCP_ERROR |
| MCP hallucinated dangerous tool rejected | server 宣告的 dangerous_delete 被模型猜到也无法执行，计数为零 |

`approval.test.ts` 另外验证 AI SDK 的 `needsApproval` 原生返回 approval request，执行次数为零。没有实现产品审批 UI 或真实 Lease。

`pi-resources.test.ts` 实际使用 Pi **SDK**：DefaultResourceLoader 禁止默认扩展、主题、prompt、context file 发现；只执行本仓库的可信内联 factory 注册一个无副作用命令；加载固定 SKILL.md；SessionManager.inMemory 不产生 session 文件。没有 spawn Pi CLI、加载第三方 extension 或启用任意默认编码工具。custom tools、abort、事件和 MCP bridge 则由统一矩阵覆盖。

## 原生能力与封装成本

| 能力 | AI SDK | Pi | Mastra |
|---|---|---|---|
| 原生迭代 | ToolLoopAgent.stream | Agent.prompt | Agent.stream |
| provider | createOpenAICompatible | 自定义 Model + streamSimple | 同一 createOpenAICompatible |
| 原生模型取消 | AbortSignal | Agent.abort + streamFn signal | AbortSignal |
| 工具等待取消 | **wrapper fence** | **wrapper fence** | **wrapper fence** |
| 最大步数 | 原生 stepCountIs + host 结果归一 | 原生 shouldStopAfterTurn hook，计数由 host 提供 | 原生 maxSteps + host 结果归一 |
| 30 秒 run timeout | host timer | host timer | host timer |
| 一个工具/轮 | provider parallelToolCalls=false 提示 + host 硬限制 | sequential 仅保证串行；host 硬限制数量 | provider 提示 + host 硬限制 |
| Zod | 原生 | Zod → JSON Schema 一次，SDK TypeBox 形状；转换前另校验 | 原生；从 tool-call 归一验证错误 |
| Context | prepareStep 返回有限 messages | transformContext + prepareNextTurnWithContext | prepareStep + rotateResponseMessageId |
| MCP | @ai-sdk/mcp discovery，过滤后注册 | 官方 MCP SDK Client 手工桥接到 custom tool | @mastra/mcp discovery，过滤 local_echo 后注册 |
| 额外 Memory / DB | 未启用 | 未启用 | 未启用 |

**取消边界：** 所有 <1000 ms 断言是“调用 abort 后 run Promise 有界结束”。Host 同时传递原生取消并使 fixture epoch 失效；晚到的 click 在真正修改状态前检查 epoch，所以不是只用 Promise.race 隐藏继续发生的点击。工具开始前的 fence 阻止后续新调用。任意外部工具若已发出不可取消副作用，不能靠这套代码撤销；JS 同步阻塞也会阻止同进程定时器及时触发。这是三者共同的 wrapper 限制，不能标成纯 native reliable tool abort。

**恢复边界：** 新 run 不恢复 SDK 内部旧调用；当前只用 FakeModel 从 observe 开始验证协议。真实宿主未来仍须在 Gateway/Lease 层强制所有权，不能只相信 prompt。

**上下文边界：** 裁剪的是模型可见历史，并对 Pi 的下一轮 context 做替换。SDK 的公开 transcript/step result 集合可能仍保留本次 run 历史；没有做 heap profile，也没有声称 recentTurns 会裁掉全部 SDK 内存。该实验是最多 10 步（专项 20 步）的短命 run；工具结果固定且小。长文本、大工具结果、无限会话的 byte/token 上限仍需生产设计。三者均没有被迫使用不可控的外部持久 Memory。

## 实测中发现的适配问题

1. **Pi 参数强制转换。** 初版只在 execute 内 Zod 校验，SDK 已把非法参数转换，导致 `invalid schema` 的 Gateway 零调用断言失败。现从原生 `message_end` 在转换前检查原始 toolCall；非法值直接终止。代码：`src/pi/index.ts` 的校验注释处。
2. **Mastra 错误事件不同。** 非法 schema 并不总是表现为 tool-error；现检查 tool-call 原始参数，并按工具名区分 UNKNOWN_TOOL。不能把所有 tool-error 都标成验证错误。
3. **Mastra 消息聚合。** 初版直接复用 prepareStep 的 messages，却没有轮换响应消息 ID，20 步裁剪断言失败，该次耗时约 87 秒。现每步调用 `rotateResponseMessageId` 后，统一 20 步测试通过；一次修正后的独立运行约 358 ms。这是适配方式导致的失败，不能据此宣称 SDK 原生不可控制。
4. **Mastra 默认错误日志包含 toolArgs。** 注入 MCP 错误时，SDK 打印了 fixture 的 `{text:'hello'}`；[最终 TAP](results/tests.tap) 保存该证据。未来接入产品时必须显式控制日志/脱敏，不能将此实验的日志行为直接继承到 M1.3 隐私模型。

## 依赖、代码与性能

[measure.ts](src/measure.ts) 实际调用 `pnpm list --depth Infinity --json`，按唯一 `name@version` 统计该命令报告的闭包，包括 peer/optional 条目，不等于磁盘物理安装包数量。直接根各为 4 个：内核、兼容 provider 或 Pi provider、MCP 支持、Zod。开发工具不进入候选闭包；不同版本算不同包，候选间共享包不能把三列简单相加。

| 候选 | 直接依赖 | 传递包 | 总闭包 | Adapter 非空非注释 TS LOC | 物理行数 |
|---|---:|---:|---:|---:|---:|
| AI SDK | 4 | 16 | 20 | 43 | 44 |
| Pi core + bridge | 4 | 209 | 213 | 51 | 53 |
| Mastra | 4 | 236 | 240 | 41 | 42 |
| Pi coding SDK 可选探针 | 1 | 243 | 244 | 不计入内核 | — |

整个实验 9 个运行直接依赖、4 个开发直接依赖；pnpm 报告生产闭包 360，总闭包 420。Pi coding SDK 仅探针使用，是与 core 重叠的可选闭包，不应再把 244 直接加到 213 上。

LOC 只统计 `src/ai-sdk`、`src/pi`、`src/mastra`，不含 common、tests、生成文件。共用 RunHost 约 81 个物理行，三个候选都依赖它；没有把 one-tool/取消成本藏成“SDK 原生”。当前代码有紧凑语句，LOC 不等于复杂度，Mastra 较少的行数也不能抵消 API 语义适配成本。

| 候选 | 冷启动 median / p95 (ms，n=10) | 四步 Fake loop median / p95 (ms，n=100) |
|---|---:|---:|
| AI SDK | 620.06 / 856.30 | 19.86 / 29.07 |
| Pi | 2570.29 / 2869.53 | **13.85 / 22.24** |
| Mastra | 2072.47 / 2438.81 | 45.84 / 71.55 |

冷启动从父进程 spawn 到子进程输出 adapter ready，含 Node/tsx、SDK 与 MCP 模块 import；ready 是导出的可运行 adapter 对象，尚未建模型连接/Agent run。每次独立进程、顺序测量；不是清空 OS 文件缓存的磁盘冷读。Fake loop 从调用 adapter.run 到返回，含原生 Agent 构造、4 次 localhost HTTP/SSE、schema/Gateway/事件处理；import 已排除，100 次包含第一轮，无真实外部模型 latency。p95 用 nearest rank；这是同机工程比较，不是普适性能排名，也不是单纯 SDK CPU 时间。

## 固定版本与许可证

来源为实际安装包的 `package.json`，原始 version/license/repository 收录在 [dependencies.json](results/dependencies.json)。以下是直接候选包，不声称已经审计全部传递依赖的许可证。

| 包 | 版本 | metadata license |
|---|---|---|
| ai | 7.0.93 | Apache-2.0 |
| @ai-sdk/openai-compatible | 3.0.44 | Apache-2.0 |
| @ai-sdk/mcp | 2.0.45 | Apache-2.0 |
| @earendil-works/pi-agent-core | 0.85.1 | MIT |
| @earendil-works/pi-ai | 0.85.1 | MIT |
| @earendil-works/pi-coding-agent（开发探针） | 0.85.1 | MIT |
| @mastra/core | 1.64.0 | Apache-2.0 |
| @mastra/mcp | 1.17.3 | Apache-2.0 |
| @modelcontextprotocol/sdk | 1.30.0 | MIT |
| zod | 4.5.4 | MIT |

同一候选的上述核心子包未发现 license 不一致；MCP 官方 bridge 的 MIT 与 AI SDK/Mastra 的 Apache-2.0 差异已单列。Pi 使用当前迁移后的 `earendil-works` 命名，未把旧 `@mariozechner` 版本与新 SDK 混测。

官方参考：[AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)、[AI SDK agents](https://ai-sdk.dev/docs/agents/building-agents)、[AI SDK repository](https://github.com/vercel/ai)、[Pi Agent SDK](https://github.com/earendil-works/pi/tree/main/packages/agent)、[Pi coding SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[Mastra Agent](https://mastra.ai/reference/agents/generate)、[Mastra repository](https://github.com/mastra-ai/mastra)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。版本判断以 lockfile/包元数据为准，滚动官网用于理解 API。

## 加权评分（100 分）

评分是针对本任务的工程选择，不是统计推断。每行从权重满分扣除下表列出的已观察成本；相同不足同样扣分。真实模型、长期维护 SLA、生产安全、长任务性能未测，不给这些能力编造加分。

| 指标 / 满分 | AI SDK | Pi | Mastra | 测试结果、代码位置与扣分说明 |
|---|---:|---:|---:|---|
| ReproPath 架构适配 /20 | 19 | 18 | 15 | 三者 normal/budget/context PASS；[AI](src/ai-sdk/index.ts)、[Pi](src/pi/index.ts)、[Mastra](src/mastra/index.ts)。AI 需统一 host 扣1；Pi 还需原始 tool-call 适配扣2；Mastra 除 host 还需 response ID/消息生命周期适配，扣5。没有新增产品依赖。 |
| OpenAI-compatible /15 | 15 | 15 | 15 | 同一 FakeModel wire 路径 normal、stream、protocol-error PASS；各 adapter provider 配置 + [fake-model.ts](src/common/fake-model.ts)。都可外部配置三变量，不因未执行真实 smoke 对某一家单独加减分。 |
| Abort / takeover /15 | 14 | 14 | 14 | plain abort、两类 takeover/resume、timeout PASS；[host.ts](src/common/host.ts) + 三个 adapter 的 signal/native abort。均需工具 epoch fence，不能撤销任意 JS 副作用，各扣1。 |
| Tool / Zod /10 | 10 | 7 | 9 | invalid schema PASS；[schemas](src/common/gateway.ts) + adapter。AI 原生；Pi 转换一次且需转换前校验，扣3；Mastra 需 tool-call 错误归一，扣1。 |
| One-tool-per-step /10 | 9 | 9 | 9 | 两项并发测试 PASS；host.execute 的 used guard。三者都需 host 硬限制；provider 提示/sequential 不是数量限制，各扣1。 |
| MCP / 插件 /10 | 9 | 7 | 9 | echo、error、危险工具拒绝均 PASS；三 adapter MCP 分支 + [mcp.ts](src/common/mcp.ts)。AI/Mastra 内置客户端仍需 allowlist，扣1；Pi 要手工桥接且 extension 不是隔离边界，扣3。 |
| Context /5 | 5 | 5 | 3 | 20-step PASS；[context.ts](src/common/context.ts) + prepare/transform hooks。三者可裁剪模型输入；Mastra 需要额外轮换 ID 防聚合，扣2。分数不代表 heap 内存已测。 |
| Event / UI streaming /5 | 5 | 5 | 4 | normal、stream、error events PASS；各 adapter 事件循环。AI/Pi 可直接映射；Mastra 需区分 tool-call 与 tool-error 两条错误路径，扣1。未接产品 WebSocket。 |
| Dependency / complexity /5 | 5 | 2 | 2 | [依赖/LOC](results/dependencies.json)、[性能](results/benchmark.json)。本次轻量门槛：闭包≤50 且冷启动median<1s给5；闭包>200且median>2s给2。Pi warm最快，仍不改变此项启动/依赖判据。 |
| License / ecosystem / maintenance /5 | 4 | 4 | 4 | [metadata](results/dependencies.json) + 全套测试在固定版本上通过，直接候选包宽松许可且有官方 SDK。长期维护未验证，各保留1分；不按流行度或品牌排序。 |
| **总分** | **95** | **86** | **84** | 细项是可讨论的工程取舍；三者功能验收均通过。 |

## 插件隔离与最终回答

**Q1：默认内嵌 Kernel？PRIMARY AI SDK。** 原生 ToolLoopAgent 已覆盖迭代/stop/prepare/stream/approval，Zod 不需要转换；20 包闭包与约 620 ms 启动适合小型独立 Agent Host。取消与每轮一个工具仍由 ReproPath Host/Gateway 强制，而不是将执行权交给框架。该结论仅批准后续设计方向，不是已接入生产。

**Q2：外部 adapter / power-user integration？SECONDARY Pi。** 最快的假循环、自定义工具、原生事件和公开 session/context 控制有价值；coding SDK 的扩展、资源与会话适合可选 power-user 接入。它需要额外 Zod 原始参数校验和 MCP bridge，且冷启动/依赖更多，因此不选作默认轻量内核。Mastra 对需要其更完整平台的应用仍可能合理，但当前核心场景没有用到这些能力，故 **NOT RECOMMENDED FOR CORE**。

**Q3：插件边界选 MCP-first。** AI SDK 生态主要为 provider/tool 包及 MCP；这些包的 execute 回调仍在 host 内执行 JS。Pi extension factory 可以执行任意 JS；skill 本身是 Markdown 资源，不自动成为沙箱，它可引导模型使用已授权工具，不能因此获得新权限。Mastra tool/integration 回调也在当前进程执行；注册工具或 MCP discovery 都不等于授权。以固定 Gateway + MCP capability allowlist 作为跨内核边界，框架原生插件只作为受信任的可选实现细节。MCP 是协议，不是沙箱；恶意 MCP server 仍需要独立部署与资源/权限限制。本任务没有实现这些隔离措施。

**Q4：值得独立 Agent Host 进程吗？值得，作为正式 M2 的后续设计。** 三者模型取消均可用，但插件 JS、SDK 错误日志、同步 CPU 阻塞和不可取消工具会越过 Promise 层的控制。独立进程有利于 watchdog、故障退出和依赖隔离；真正的副作用授权仍放在外部 Gateway/Lease 层，杀进程不能撤销已经提交的操作。当前只在冷启动 benchmark 中创建短命子进程，未实现生产 Host/sandbox。

**Q5：未来换 Kernel，Gateway API 能保持吗？本次验证可以。** 三 adapter 使用完全相同的 observePage/click/finish 类型、Zod schema、Observation ID 约束和事件结构。将 SDK message、tool call ID、provider 类型保持在 adapter 内即可更换内核。未来如果扩充业务工具或真实权限，需要独立版本化 Gateway 协议；不能声称本实验三个方法已覆盖全部生产需求。

## 当前限制

真实 endpoint smoke 未执行；FakeModel 是脚本式协议注入，不测试模型推理质量。未测试远端 MCP 网络抖动、恶意服务内容、复杂多模态、巨型结果、长期会话、强杀恢复或 OS sandbox。30 秒 timeout 在事件循环不被同步阻塞的条件下有效；工具取消依赖工具自身配合。CAPTCHA/登录保持未解决且完全不在实验范围内。没有 Agent UI、Browser Tools、AI diagnosis、Memory、RAG、数据库、生产 plugin manager 或多 Agent。
