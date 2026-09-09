# ADR 001 — Agent Kernel 与 Driver 边界

状态：Accepted · 2026-09-08 · M2.0

## 决策

采用 AI SDK ToolLoopAgent 作为默认 kernel；AI SDK 7.0.93、OpenAI-compatible 3.0.44、Zod 4.5.4 锁定版本。依据是 [Agent Kernel bake-off](../../experiments/agent-kernel/results.md)；本 ADR 不扩展实验结论到未经验证的模型服务。

Agent Host 是独立 Node 进程。模型依赖、流式协议和 AbortController 留在 Host；Control 负责 Run 生命周期、策略、唯一控制权和 epoch；Worker 负责真实 Chromium、语义观察与统一记录操作。Host 只能调用 version=1 的 ReproPath Tool Gateway，不能直接连接 Worker 或访问 Playwright。

MCP-first 指未来对外工具适配优先使用 MCP 边界，当前内部 Gateway 是有版本的私有 localhost WebSocket。M2.0 不引入 Playwright MCP、Chrome DevTools MCP 或 MCP browser adapter。MCP 本身也不构成浏览器安全沙箱。

Pi 保留为次级 external driver 方案，未来必须通过同一 Gateway 和 Control Authority；不与默认 kernel 混用。Mastra、Pi 和实验包都不进入生产依赖。公共协议不携带 AI SDK 类型。

## 约束与后果

- Human 和 Agent 共用一个 Control Authority；Human 优先，先撤销 epoch 再取消模型。释放 Human 不自动恢复 Agent。
- 每轮强制一个模型工具；每轮重新观察，仅保留最近 5 步摘要；20 步 / 5 分钟硬预算。
- 所有 Agent 页面变更通过现有 ActionRecorder 的公共记录入口，复用 Evidence、Signal、Finding，不建立第二条截图或检测管道。
- 不保存 hidden reasoning，不把截图、输入 value、Cookie、Storage、完整 DOM 或 body 发送给模型；可见业务文本仍需要用户自行评估。
- 多一个进程带来重连与失联处理成本，但模型等待和 Host 崩溃不会占住 Control 的人工撤权路径。
- 元素引用短期有效，当前只支持主文档的有限语义元素，不能视作通用 locator 或 Replay 数据。
- 语义危险操作过滤是有限规则，origin 校验不是网络沙箱；本机单用户信任边界保持不变。

未来 driver 必须保留上述控制、隐私和统一记录约束。本阶段不开始 M2.1、Memory、多 Agent 或自动诊断。
