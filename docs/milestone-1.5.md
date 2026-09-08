# Milestone 1.5 — Signal & Finding Foundation

验收日期：2026-09-08，Asia/Shanghai。分支 `feat/milestone-1.5` 基于 `ee5ecc3`（M1.4 PR #3 已合并的 main）。仅实现六类确定性 Signal、Session 内 Finding grouping 和人工 triage。

**Finding is not a Bug or Issue. No AI is used in detection or triage.** 没有 AI/LLM/Agent、自动诊断、confidence、Issue/Bug 对象、Replay、产品 Regression、APM、通知或数据库。

## 架构与对象

```text
Worker: real Chromium → SessionEvent + ActionUpdate
                                     ↓
Control: SignalDetector.onEvent / onAction
             ↓ independent UUID + safe facts + fingerprint
         SignalStore (append-only, bounded retention)
             ↓ same Session + same fingerprint
         FindingStore (candidate + human triage)
             ↓ REST + WS
Web: Live Session → Findings → Actions → Raw Timeline
                        ↓
              existing Action / ArtifactRef / Evidence
```

`packages/protocol/src/finding.ts` 定义独立 Zod schemas、facts discriminated union、REST 与 WS 模型。Signal 不复用 SessionEvent ID，不保存人工状态；没有更新 Signal 的 API。保留期内事实不变，对外读取使用副本。Finding 是聚合与人工判断对象，并非新的事件类型。

`apps/control/src/signal-detector.ts` 为可直接单元测试的 Session 检测器；`detection.ts` 包含 SignalStore、FindingStore、SessionDetection 和生命周期 registry。React 无检测规则，Worker 没有 Finding 副本，Control index 仅接线和路由。未修改 M1.4 Recorder、settle、Evidence 或原 SessionEvent schemas。

## 六类规则与 Severity

| Kind | 条件 | Severity | 安全 facts |
| --- | --- | --- | --- |
| HTTP_5XX | 500 ≤ response.status ≤ 599 | high | requestId、method、safeEndpoint、status |
| REQUEST_FAILED | requestfailed 且原 Request resourceType 非 document | medium | requestId、method、safeEndpoint、resourceType、failureHash |
| DOCUMENT_REQUEST_FAILED | requestfailed 且原 Request resourceType=document | high | 同上；不同时生成 REQUEST_FAILED |
| PAGE_ERROR | pageerror | high | safePage、messageHash；不复制 stack |
| CONSOLE_ERROR | console.level=error | medium | safePage、messageHash；不复制 console text |
| DUPLICATE_REQUEST | 同 Action、同 mutating method、完全相同 raw URL，≤1000ms 至少两次 | medium | method、safeEndpoint、count、windowMs，requestIds/sourceEventIds |

不检测 HTTP 2xx/3xx/4xx、console log/info/debug/warning、GET duplicate、性能、业务规则或视觉问题。HTTP 404 自身不产生 HTTP_5XX；Chromium 自行打印的网络 console.error 仍符合独立 Console 规则，不能过滤它来制造单 Finding 的表象。

## Safe endpoint 与 fingerprint

safeEndpoint 使用 URL parser，只保留 HTTP(S) origin + pathname。userinfo、所有 query（包括 key）、fragment 被删除；非 HTTP URL 或解析失败用固定占位。例如 `https://a.test/api/user?id=123&token=SUPER_SECRET` → `https://a.test/api/user`。路径本身仍可能含业务标识，不声明消除路径秘密。

Fingerprint 是 JSON 数组编码后 SHA-256，不是原始文本，也不含 Session/Action/时间：

- HTTP：kind、method、safeEndpoint、status。
- requestfailed：kind、method、safeEndpoint、resourceType、SHA-256(error)。
- page/console：kind、safePage、SHA-256(message/text)。
- duplicate：kind、method、safeEndpoint。

稳定输入产生稳定 hash，可跨 Session 比较，但本阶段仅在单 Session 聚合。不同 kind 绝不自动合并。PAGE_ERROR/CONSOLE_ERROR 用固定标题，不复制消息原文；Duplicate 标题不嵌入某一次 count，具体 count 在 Signal facts 展示。

## Action 与慢响应关联

记录 Page→recording Action 和 requestId→Request facts/actionId。Request 到达时固定其 Action，response/requestfailed 根据 requestId 查询，所以晚于 Action completed、甚至下一 Action 已开始的 response 仍属于原 Action。ActionUpdate 的 networkRequestIds 还可补回尚未关联的 Request。页面自主错误保留 `actionId=undefined`，不取最近一次点击。

Request 历史被淘汰后无法可靠恢复 method/resourceType/action；此时不猜测分类，增加 runtimeDropped 并在 UI 警告。每条事件按 Session 序号去重，以 map lookup 为主，不扫描 10,000 条历史；Action update 最多处理原协议的 1000 个 requestId。检测不做 IO、没有新的输入等待或外部调用。

## Duplicate 结算

仅 POST/PUT/PATCH/DELETE，raw URL 用 hash 作短期精确相等索引（不是 grouping fingerprint，也不输出）。每个 Action、method、URL 从第一条请求起建立非重叠 ≤1000ms 窗口。后续同组请求超过窗口时结算前一窗口并开始下一窗口；Action completed/interrupted 时结算剩余窗口，重复 terminal update 不再产生 Signal。

没有每次请求就追加 Signal 再修改 count 的做法：同窗 ×3 只追加一次、count=3、三个 requestIds；下一 Action ×2 是第二个 Signal，Finding occurrenceCount=2。不同 query value、不同 method、不同 Action、单请求、GET 或无 Action 不报 duplicate。

窗口不会每毫秒扫描；若没有新的同组请求，直到 Action 结束才输出。非常长的未结束 Action 会延迟输出。显式 Session close/shutdown 会丢弃尚未结算窗口，避免 teardown 新信号。最多计数 1000 个请求/窗口，超额有 runtimeDropped 提示，不作无限精度或无限保留承诺。

## Finding 与人工 triage

同 Session、同 fingerprint 的 Signal 累计 occurrenceCount，更新 first/lastDetectedAt、updatedAt、revision，signalIds 添加、actionIds 去重。默认 candidate（待确认）；`confirmed`、`not_issue`、`known_issue` 与恢复 candidate 均为人工操作。后续同指纹发生不重置决定。PATCH 严格只接受 status，Signal facts 不可修改。

固定标题示例：`HTTP 500 · GET http://…/500`、`请求失败 · GET …`、`页面导航请求失败 · GET …`、`页面 JavaScript 异常`、`Console Error`、`疑似重复请求 · POST …`。不推断 Bug、不关联不同规则的“同一个问题”，重试/batch 可以合法。

## 存储上限与生命周期

| 项目 / Session | 上限与超限行为 |
| --- | --- |
| Signals | 2000，淘汰最旧并累加 signalsDropped |
| Findings | 500，不淘汰人工决定；拒绝新的 fingerprint，findingsDropped 计被拒绝的发生次数；已有 fingerprint 继续累计 |
| Finding signalIds / actionIds | 各最近 100，referencesTruncated=true；occurrenceCount 不受截断影响 |
| Request facts/action 索引 | 10,000，淘汰最旧，runtimeDropped 累计 |
| Page URL / active Action / terminal Action IDs | 各 500，保持有界 |
| Duplicate | 最多 500 Action 分组、每 Action 1000 URL 分组、所有 pending 请求引用总共 10,000、单窗口 1000 请求 |

Finding 的 Action 数表示保留的去重引用数量，不是无限期唯一 Action 总数。signalIds 可以指向已被 Signal ring 淘汰的数据；UI 显示 unavailable。原始事件仍受 10,000 历史上限，Action 仍受 M1.4 最近 500 上限。

stats 包含 signalsRetained/signalsDropped/findingsRetained/findingsDropped/runtimeDropped。API 和 WS 均提供，UI 明确显示容量/关联丢失警告；runtimeDropped 也计缺失 Request 导致的无法检测。

DELETE Session 在向 Worker 发 close 前 stop detector，Control shutdown 同样先 stopAll；Worker 断开/Session failed/closed 清理 runtime maps。关闭后当前进程保留 Signals、Findings、triage 与 M1.4 Evidence 引用，可继续阅读和 triage。Control 的 100 Session 上限淘汰旧 Session 时 registry、stores、runtime 同时删除。重启不恢复，不改变 Artifact 文件生命周期。

## REST / WS / UI

| Endpoint | 结果 |
| --- | --- |
| GET /sessions/:id/signals | `{ signals, stats }` |
| GET /sessions/:id/findings | `{ findings, stats }` |
| GET /sessions/:id/findings/:findingId | Finding；未知 404 |
| PATCH /sessions/:id/findings/:findingId | JSON `{status}`；成功 Finding；非法状态/额外字段/坏 JSON 400，非 JSON 415，未知 404 |

WS 新增 signal-created / finding-update / detection-stats。重连单独 REST 恢复，不扩展 SessionEvent snapshot；Finding revision 保持较新人工决定，旧连接 REST 响应被忽略。没有服务端 Signal 更新消息。

Findings 显示 severity、固定标题、人工状态、发生次数、首末时间、保留引用数。展开 Signal facts 后按 sourceEventIds 展示原始事件，PAGE_ERROR 的 message/stack 仅来自这里。复用 Actions 组件查看最近一个仍保留的关联 Action，包括原有 Before/After、Network、evidenceStatus；没有复制任何 Evidence 文件。无 Action 明确提示页面自主行为。

## 隐私边界

Signal/Finding JSON 不复制 query value、原始 console text、完整 stack、Cookie、Storage 或请求/响应 Body。使用公开 fixture 假值验证 `SUPER_SECRET`、query `123` 和错误原文不进入派生 JSON。原始 SessionEvent、Timeline、Live View 与 M1.4 Evidence 的既有边界不重做；点击“原始 SessionEvent”可能看到原始 URL/message。哈希不是加密或通用 DLP，页面普通内容仍按 M1.4 保存。

scoped auth import 继续仅为 **local diagnostic/bootstrap functionality**，本次测试不读取或导入用户 auth 文件。**CAPTCHA：unresolved and non-blocking**，本阶段未尝试修复，不保证第三方验证可通过。

## 验收环境与结果

Windows / PowerShell，Node.js 24.6.0，pnpm 10.17.1，Playwright 1.55.1 / Chromium 140.0.7339.186，Vite 7.3.6。测试服务用隔离本机端口和 test-results artifact 目录，Chromium 需本机进程执行权限，目标全为本地 fixture。

最终命令：`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。测试 **64/64，0 失败、0 跳过**，包含原 M1.1–M1.4 的 44 项与 M1.5 新增 20 项（Node test runner 含父项计数）。Web 生产构建成功。预期 fixture 导航超时/crash/启动失败日志来自负例，不是套件失败。

新增检测单元测试 8 项：六类与负例、稳定 hash/URL 隐私、慢响应与跨 Page、duplicate 精确窗口与基数、三 Action grouping/人工状态、有界存储、teardown/registry 清理。

新增集成/UI 12 项（含父项）：真实 Human Control、HTTP 500/Evidence、三 Action 聚合与四种人工状态、重复 POST 与单 POST/GET/warning/404 负例、真实 pageerror/console/socket destroy、慢 3.5s 500、privacy、刷新/明确断开 WebSocket 重连、pending 请求关闭、document 断连，以及 2025 事件/500 Finding 容量警告。容量压力使用测试 Worker 协议输入，其余检测链路使用真实 Chromium。原 M1.1–M1.4 测试全部保留。

## 可见浏览器人工验收

2026-09-08 11:38–11:43（Asia/Shanghai），Codex 内置浏览器访问 Web `http://127.0.0.1:5176`，Control `4340`，Worker `4341`，远程 viewport 1440×900。使用 Web UI 和远程画面实际点击，没有用 API 替代 triage/点击验收。

Session：`5c3084e3-8417-4988-af01-52ecbe4cdfc1`，目标 `/test-page/signals`。一个额外空白点击形成正常无异常 Action，未删除记录。

| 步骤 | 观察结果 |
| --- | --- |
| 创建 / 接管 | running、LIVE、HUMAN CONTROL |
| HTTP 500 | 实时 1 HTTP_5XX Signal / 1 该类 Finding，candidate；原请求和 Action 正确 |
| 查看关联 Action | Before/After 真实图像、HTTP 500 网络行，Evidence complete |
| 点击“确认问题” | 已确认问题 |
| 再次 HTTP 500 | 同 Finding 出现 2 次、两个 Action，仍 confirmed |
| Console Error | 另一个独立 Console Finding |
| Duplicate POST | 一个 Signal、一个该类 Finding；facts.count=3、windowMs=1、三个原 Request |
| 刷新 | VIEW ONLY、6 Signals / 4 Findings / 5 Actions 恢复；HTTP Finding confirmed 保留 |
| 关闭 | closed、接管不可用，仍 6 Signals / 4 Findings；原 Evidence 可展开且图像可见 |

4 个 Finding 包含一个 Chromium 对 HTTP 500 自行发出的 Console Error 聚合；这是独立规则的预期结果。跨 kind 未合并。自动化另验证关闭进行中请求不增加新 Signal、响应在 settle 后仍关联、390px 布局与断线恢复。

## 已知限制

- 单本机、单 Control 进程内聚合；无持久化、跨 Session grouping 或自动根因推断。
- 异常不等于 Bug；HTTP 失败引起的浏览器 console.error 可以产生另一个 Finding。合法重试可能被标记 duplicate，需要人工判断。
- 去掉 query 使不同参数值共享安全 endpoint/grouping；duplicate 检测本身仍精确比较 raw URL。
- 消息含动态值时 hash 不同；未做模糊匹配、stack 归一化或语义分析。
- 有界索引/引用淘汰、未结束 Action 的 duplicate 延迟、关闭丢弃未结算窗口，可能使检测或详情不完整；stats/UI 会提示容量损失。
- Source Event 与 Evidence 的原有隐私边界继续适用。没有新增数据库、HAR、Body/Video 捕获、外部系统集成、CAPTCHA 修复或 Agent/M2 功能。
