# M2 Agent Kernel Bake-off

这是独立的内核选型实验，不是正式 M2。三个 SDK 的原生 Agent loop 使用同一目标、Zod schema、Mock Gateway 和本地 OpenAI-compatible FakeModel。没有接入 ReproPath Browser、Control Lease、Action 或 UI，也不处理登录和 CAPTCHA。

## 运行

环境：Node.js 24+、pnpm 10.17.1。此目录有独立 workspace 和 lockfile；不要在根 workspace 安装实验依赖。

```powershell
cd experiments/agent-kernel
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm agent:bakeoff
pnpm test
pnpm agent:bakeoff:real
pnpm agent:bakeoff:bench
pnpm agent:bakeoff:measure
```

`agent:bakeoff:test` 是 `test` 的别名。Fake tests 仅使用临时 localhost HTTP/SSE 和 MCP 服务，不调用外部模型。所有服务在测试结束后关闭。测试中的 SDK 错误日志来自刻意注入的协议/工具错误，最终以 TAP 断言为准。

MCP smoke 已包含在每个候选的测试中：真实 HTTP MCP discovery → allowlist → echo → 返回模型；同时验证错误结果和恶意 `dangerous_delete` 调用。服务器声明两个工具，模型只收到 `echo`，危险工具只是计数器，没有删除实现。

## 可选真实模型

从调用进程环境读取以下三个变量，缺少任意一个就打印 `SKIP` 并成功退出：

```text
AGENT_BASE_URL    OpenAI-compatible /v1 endpoint
AGENT_API_KEY     由本地环境注入
AGENT_MODEL       endpoint 支持的模型名
```

`pnpm agent:bakeoff:real` 依次使用同一配置运行三个候选，仍然只操作 Mock Gateway。程序输出状态和步数，不输出 key 或模型原始内容。不要把真实 key 写入代码或提交到 Git。普通 `pnpm test` 永远不读取这些模型配置。

本次真实模型 smoke 为 **SKIP**；FakeModel 通过不能证明任意兼容服务都支持完全相同的协议细节。

## 结构与约束

- `src/common/types.ts`：稳定 Gateway / Run / Event 协议。
- `src/common/gateway.ts`：确定性登录页，单调 Observation ID，过期 ID 拒绝，点击后必须重新观察。
- `src/common/host.ts`：步数、30 秒超时、每轮一个工具、取消 fence；没有模型迭代循环。
- `src/ai-sdk`、`src/pi`、`src/mastra`：实际 SDK 原生循环和事件适配。
- `tests/kernel.test.ts`：对三个候选复用相同验收；另外验证 AI SDK 审批及 Pi 可信扩展/资源 SDK。

默认最多 10 个模型轮次、保留最近 2 组完整 assistant/tool 历史。接管返回 `paused_by_human`，并使 Mock Gateway 旧能力失效；恢复通过新 run 从 fresh observation 开始。本实验没有实现真实 Lease，也没有声称 AbortSignal 能强行中止任意 JavaScript 副作用。

Pi 的 coding-agent SDK 只作为开发依赖用于可信内联扩展、skill loader 和内存 session 探针，不在内核适配器中启动 CLI 或加载第三方扩展。Mastra 没有配置数据库、Memory、持久工作流、服务端或观测后端。

## 结果

[完整评估与 Q1–Q5](results.md)；[原始性能样本](results/benchmark.json)；[依赖、许可证和 LOC](results/dependencies.json)；[59 项测试 TAP](results/tests.tap)；[回归记录](results/verification.json)。

重新生成性能/依赖文件会修改工作树。冷启动每候选 10 次，四步 FakeModel 循环每候选 100 次。全部顺序运行，不启动常驻实验服务。

当前推荐：**PRIMARY AI SDK；SECONDARY Pi；NOT RECOMMENDED FOR CORE Mastra**。这是当前最小内嵌场景的选择，未开始正式 M2，也未评价完整业务平台功能。
