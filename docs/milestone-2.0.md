# Milestone 2.0 — Agent Driver Foundation 验收记录

日期：2026-09-08（Asia/Shanghai）。分支：feat/milestone-2.0。

## 环境与执行方式

Windows x64；Node.js 24.6.0；pnpm 10.17.1；Playwright 1.55.1 对应真实 Chromium。Web、Control、Worker、Agent Host 均为独立服务；自动测试使用隔离端口、独立 Context 和忽略的 test-results artifact 目录。未使用认证 Cookie 或外部登录站点。

依赖锁定 AI SDK 7.0.93、OpenAI-compatible 3.0.44、Zod 4.5.4。模型替身仅在 tests/ 中，通过真实 OpenAI-compatible HTTP/SSE 响应驱动真实 ToolLoopAgent；没有替换 Worker、Playwright、Gateway、Evidence 或检测器。

手工复核使用一套 pnpm dev：Web 5177、Control 4350、Worker 4351、Agent Host 4352。测试模型 `tests/agent-manual-model.ts` 监听 6509，仅用于本地验收；不是默认生产模型。复核结束后撤除测试模型配置。

## 命令与测试

| 检查 | 结果 |
| --- | --- |
| pnpm install --frozen-lockfile --store-dir D:/.pnpm-store | PASS，执行 Chromium postinstall |
| pnpm typecheck | PASS，根项目及全部工作区 |
| pnpm test | 88/88 PASS：原有 64 项 + M2 新增 24 项 |
| pnpm build | PASS，Web 生产构建 |
| pnpm dev | PASS，四个服务运行，本地 UI 和模型 Gateway 联通 |
| pnpm agent:smoke | SKIP，未配置真实外部模型环境变量 |

真实 endpoint 的流式工具、Unicode 和取消兼容性尚未在此环境验证；smoke 提供这些检查。畸形工具 schema 的 smoke 检查是本地校验；实际 SDK 畸形工具回复、未知工具、多工具回复使用确定性模型在自动测试中验证，不声称外部模型会产生这些对抗样本。

M1.1–M1.5 原有测试全部保留：浏览器隔离、生命周期、事件身份、Live View 背压、Human 输入与租约、隐私、Evidence、六类 Signal、Finding 聚合和 triage。M2 新增覆盖：

- 真实 Host → Control → Worker → Chromium → Agent Action / Evidence / HTTP_5XX / Finding。
- 一回合多工具硬拒绝、未知工具、schema 错误、危险目标、同 origin navigate。
- 语义观察的输入排除、隐藏元素排除、文本/元素上限、失效和 detached ref。
- 延迟模型人工接管、模型请求取消小于 1000ms、旧 epoch 延迟工具零 Action / 零副作用、显式恢复。
- 20 步预算、Control 独立 watchdog、最近 5 步上下文、20 Run 保留上限。
- Human 占用、重复 Run、停止、Host 缺失/崩溃/重启、无模型配置、Worker 崩溃、关闭 Session。
- Agent 输入不进入 Step/Action/Event/应用日志和净化 DOM；统一 Evidence 路径的截图遮盖由保留的 M1.4 像素测试验证。
- 外层 Chromium 操作真实 Web：运行刷新、接管恢复、Evidence、Finding、390px 布局、关闭后读取。

## 手工浏览器复核

Session：48b8e45f-a135-4471-a2da-bd793b99b0c9；目标 `http://127.0.0.1:4350/test-page/agent`。时间约 17:39–17:42。

| 操作 | 实际结果 |
| --- | --- |
| Create Session，输入“检查登录按钮提交后是否出现异常。” | 真实页面与 Live View，running |
| Start Agent | AGENT CONTROL，四步 observe_page / click / observe_page / finish |
| 点击 Login | actor=agent 的 CLICK，真实 POST 返回 500 |
| 展开 Action | Before/After 图片、DOM 入口、关联请求及 console 可读；Evidence complete |
| 查看 Finding | HTTP 500 候选，另有 Chromium 自身 Console Error 候选，均待确认 |
| 延迟目标再次 Start，点击人工接管 | HUMAN CONTROL，Run paused_by_human，旧步骤 MODEL_ABORTED |
| 人工点击实时画面 | 出现 human CLICK；随即释放导致该 Action interrupted / partial，UI 如实提示 |
| 结束接管 | VIEW ONLY，Agent 保持 paused_by_human，未自行恢复 |
| 继续 Agent 并刷新 | 恢复 AGENT CONTROL，重新观察后点击成功，最后 completed / goal_reached |
| 关闭 Session，再刷新并展开 Action | closed，Run terminal；3 个 Actions、2 个 Findings 与 Before/After 仍可读 |

输入、键盘和截图脱敏的精确断言由自动测试完成；本次手工记录不把未成功提交的文字操作计为验收证据。Evidence settle 达到上限时显示提示，即使文件 complete 也不宣称页面已经绝对稳定。

## 实现与控制边界

Web goal → Control AgentRun → 独立 Agent Host ToolLoopAgent → Gateway v1 → Control Authority / policy → Worker semantic Observation / recorded operation → Action(actor=agent) → 原有 Evidence / SessionEvent / Signal / Finding。

Control Authority 对每 Session 保存唯一 Human 或 Agent owner。Human 以 socket/leaseId 认证；Agent 以 runId/epoch 校验，Worker 在异步等待后再次检查 epoch。接管先撤销能力再发取消，尚未注入的延迟操作不会继续执行。已经发生的网络请求无法撤销。Human 释放后必须显式 Resume，且获得新 epoch / Observation。

所有九个工具在 agent-protocol 中由严格 Zod schema 定义。Host 无 Playwright 或 Worker 连接；Control 不接受模型指定 Action/安全摘要。工具输出错误为归一化 code，不转发原始异常。Agent 与 Human 共用 ActionRecorder 的 Before/After、settle、artifact 上限和 Signal 关联逻辑。

每轮有新的有限观察，elementRef 不作为持久化 locator。模型最多看到目标、当前观察、最近 5 步安全摘要；不累积完整历史。Run 最多 20 步和累计 5 分钟，暂停不自动恢复；20 Run / Session、20 Step / Run，有界且不跨 Control 重启持久化。独立 Run/Step REST/WS 不混入 SessionEvent。

Agent Host 是唯一生产模型依赖入口。内部协议版本 1，Pi/MCP 仅保留未来边界，具体决策见 [ADR 001](adr/001-agent-kernel.md)。

## 隐私与限制

输入原文仅在临时执行链存在，持久化元数据使用 characterCount，finish 摘要对当前 Run 的已输入原文做有限移除；没有通用 DLP。模型自由输出和 hidden reasoning 不保存。Evidence 继续遮盖文本输入控件、净化 DOM；不发送截图、Cookie、Storage、完整 DOM、请求或响应正文给 LLM。

Goal、可见文本、语义标签和页面自行输出到 URL/console 的内容可能敏感；启动按钮前明确告知。模型服务凭据仅由环境变量读取，错误日志不打印 provider 原始报文。scoped auth import 仍是本地 diagnostic/bootstrap 功能，不是认证系统；不新增 auth 文件或复制 Chrome profile。

只支持原活动 Page 的主文档语义元素，不支持 iframe/shadow DOM、上传下载、跨页规划、Memory、自动诊断或自动 triage。危险操作过滤仅为有限语义规则。Agent epoch 持有控制时，Worker 在 Chromium Fetch 请求阶段拦截主 Frame 的跨 origin 文档请求，包括链接、JS 跳转、表单和每一跳 HTTP redirect；允许 origin 固定为 Session 初始 requestedUrl 的 origin。阻止的文档请求以本地 204 结束，保留当前页面，并在当前或下一次工具结果返回 POLICY_BLOCKED。非主 Frame 文档与跨域 API、图片、脚本、样式不受此 origin 规则限制；Human 接管后恢复普通导航行为。这不是网络沙箱。页面文字不可信，当前没有完整 prompt-injection 防御保证。只面向 localhost 单用户，私有 WS 不构成恶意本机进程隔离。

## 合并前加固（2026-09-09）

Host agent-end 的终态映射为：goal_reached → completed / goal_reached；budget_exhausted → completed / budget_exhausted；run_timeout、model_error、tool_error → failed / 对应原因。finish 工具仍沿用原有立即完成路径。

Agent click/type_text 的 Action target 在变更前直接读取当前观察绑定的 ElementHandle，不再依赖屏幕命中子元素或先前焦点。仅保存原有有限语义属性，不读取 value 或保存输入原文。

新增真实 Chromium 测试覆盖同源链接、外链、JS 导航、表单、跨域 HTTP redirect、跨域 API/子 Frame 放行、嵌套按钮与未聚焦输入框的归因及隐私、撤权后的 Human 导航。另以真实 WebSocket 覆盖 Host 五种终态映射与所有权释放。原有 M1.1–M2.0 测试保留。

最终验证：pnpm typecheck PASS；pnpm test **98/98 PASS**（原 88 项 + 10 项加固测试，156.4 秒）；pnpm build PASS。测试默认使用每次独立的证据目录，避免历史文件扫描耗时影响证据写入；原有帧流测试增加第二个导航 CDP 会话的监听清理断言，原有背压/帧检查保持。

CAPTCHA **未解决且非阻塞**；本次不调查、修复或绕过第三方 CAPTCHA。真实外部模型 smoke 未配置而跳过，这也限制了对具体服务兼容性的结论。

本阶段没有引入 Pi、MCP browser integration、Mastra、第二条 Evidence 管道、数据库、多 Agent、Replay、Regression 产品功能或 M2.1 工作。
