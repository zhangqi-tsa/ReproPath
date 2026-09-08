# ReproPath · Milestone 1.4 — Action & Evidence Recorder

当前能力：实时查看并人工控制真实 Chromium，将输入归并为独立 Action，在真实注入前后保存脱敏 Evidence。默认 VIEW ONLY；原有 Timeline 和 Live View 保留，Action、SessionEvent 与 BrowserFrame 各自独立。Evidence 截图由真实 Page 截取，不复用 Live View canvas。

M1.1 的历史边界（M1.2 新增 screencast，M1.3 新增 Human Control）：

> Milestone 1.1 does not implement AI, browser screencast, human takeover, evidence recording, replay, or regression testing.

## 架构与目录

```text
Chromium (独立 Context / Session，明确 1440 × 900 viewport)
  ├─ Playwright Events → SessionEvent → Control → WebSocket → Timeline
  ├─ CDP Screencast → BrowserFrame → Control → WebSocket → Canvas Live View
  └─ Playwright Mouse/Keyboard ← Worker ← Control Lease 校验 ← BrowserInput ← Web UI

apps/
  web/             React + Vite，画面、人工接管、URL 恢复、状态与 Timeline
  control/         HTTP API、事件历史、当前帧缓存、WebSocket、本地 fixture
  browser-worker/  Chromium 生命周期、Page/Frame 身份、CDP screencast
packages/
  protocol/        Zod 运行时校验与 TypeScript 通信类型
  streaming/       Worker/Control 共用的 latest-frame-wins 有界发送器
  artifacts/       ArtifactStore 接口与本地原子写入、UUID 读取和磁盘上限
tests/             真实浏览器 Runtime 与跨进程/UI smoke tests
pnpm-workspace.yaml
package.json
```

应用之间不 import 彼此实现；通信模型统一依赖 `@repropath/protocol`，后端共用 `@repropath/streaming` 的背压实现。Worker 监听本机 WebSocket，Control 主动连接并发送 start/close/帧 ACK，接收状态、事件和帧；UI 只连接 Control。测试可直接测试 Worker 的公开 Runtime 类。

## 环境与安装

- Node.js 22.12+ 或 Node.js 24+，pnpm 10（项目声明 10.17.1）。
- Windows、macOS 或 Playwright 支持的 Linux；首次安装需要访问 npm 与 Playwright 浏览器下载地址。
- 在项目根目录执行：

```bash
pnpm install
```

根项目 `postinstall` 自动执行 `playwright install chromium`，安装与锁定 Playwright 版本匹配的 Chromium。Linux 如缺少系统动态库，先执行 `pnpm exec playwright install-deps chromium`（需要系统管理员权限）。浏览器安装机制参见 [Playwright 官方文档](https://playwright.dev/docs/browsers)。

## 启动

### 可见浏览器诊断模式

可选 scoped auth bootstrap 是本地诊断/启动辅助，不是通用认证系统。设置 `REPROPATH_AUTH_FILE` 为仓库外 JSON 文件的绝对路径，格式为 `{"origin":"https://your-site.example","cookieHeader":"session=your-value"}`。仅当新 Session 的请求 origin 完全匹配时，Worker 才会在首次导航前导入 Cookie；现有 Session 不受影响。文件不得提交到 Git。请求 Cookie 不包含原属性，导入采用 host-only、会话有效期、SameSite=Lax，并按 HTTPS 设置 Secure；不恢复原有 HttpOnly、Path、过期时间或 Local Storage，不复制到其他子域。关闭 Session 清除其 Context；取消启动环境变量并重启 Worker 可停止后续导入。加载错误只返回固定提示，不输出凭据。没有 Web UI 上传/编辑认证信息的入口，也没有令牌刷新功能。

执行 `pnpm dev:headed`，创建 Session 后会弹出该 Session 所在的 Chromium 窗口；Live View 仍显示同一个 Page。默认 `pnpm dev` 保持无头模式。Worker 的 `/health` 返回 `browserMode`，可确认启动模式。

如果默认端口已有开发服务，先自行结束原服务再启动；结束服务会关闭原有 Session，模式不会热切换。可见模式需要本机桌面环境。

排查人工验证：先保持 Web UI 为 VIEW ONLY，直接在 Chromium 窗口中操作；再用 Live View 接管进行对照。直接窗口操作不经过远程控制租约，也不会生成 `human-input` 审计事件，但页面、网络和控制台事件仍正常记录。避免两处同时输入。此模式用于本机诊断，不保证验证码通过，也不修改浏览器指纹或网站校验。

```bash
pnpm dev
```

该命令同时启动三个独立进程，任一进程退出则停止其余进程。Control 等待 Worker 自动连接；浏览器在创建第一个 Session 时启动。Ctrl+C 停止开发服务。

| 服务 | 默认地址 |
| --- | --- |
| Web UI | http://127.0.0.1:5173 |
| Control API | http://127.0.0.1:4310 |
| Browser Worker 健康检查 | http://127.0.0.1:4311/health |
| 本地测试页面 | http://127.0.0.1:4310/test-page |

请使用 `127.0.0.1` 打开 Web UI，以匹配默认 Origin 配置。`GET /health` 返回 Control 的 `workerConnected` 状态。

可选环境变量：`CONTROL_PORT`（4310）、`WORKER_PORT`（4311）、`WORKER_URL`（ws://127.0.0.1:4311/worker）、`WEB_PORT`（5173）、`CONTROL_URL`（Vite 代理目标，http://127.0.0.1:4310）、`WEB_ORIGIN`（http://127.0.0.1:5173）、`NAVIGATION_TIMEOUT_MS`（15000）。改端口时同时设置相关 URL；UI 的 fixture 默认值需手动调整。

## 创建与关闭 Session

打开 Web UI，输入 `http://127.0.0.1:4310/test-page/control`，点击 **Create Session**。地址变成 `/session/{id}`，应看到 `running`、真实 Current URL / Page Title、Active Page ID 和 **● LIVE**。画面按 1440 × 900 坐标系等比缩放，默认 VIEW ONLY；点击“接管浏览器”获批后才能转发输入。

复制该地址或刷新网页会先 `GET /sessions/:id`，然后 WebSocket subscribe → snapshot → 当前帧 → 后续事件/帧，无需重新创建 Session。静态页面也可恢复最后一帧。只有 Control 当前进程仍保存的 Session 可以恢复；未知或已淘汰 ID 显示明确提示。已关闭 Session 可以恢复状态和 Timeline，但不再显示旧画面。

历史 `/test-page` fixture 加载后自动打印日志、请求 `/fixture/api/user` 并抛出未捕获异常，也提供 Request API、Console Log、Throw Error、Navigate 按钮。`?navigate=1` 自动导航到 `/test-page/next`。M1.3 使用 `/test-page/control` 验收真实点击、拖动、输入和滚动；必须在 Live View 中操作，直接打开 fixture 只会测试个人浏览器。

fixture 的计数器每 200 ms 改变，便于观察真实帧更新。`?popup=1` 自动打开新 Page，验证独立 pageId；`?static=1` 停止计数变化，验证静态页恢复。显示 FPS 是每秒实际绘制帧数，静态页面 0 FPS 仍可保持 LIVE；CDP 按画面变化产帧，不承诺固定帧率。

也可使用 HTTP：

```bash
curl -X POST http://127.0.0.1:4310/sessions -H "Content-Type: application/json" -d '{"url":"http://127.0.0.1:4310/test-page"}'
```

Windows PowerShell：

```powershell
$session = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4310/sessions -ContentType application/json -Body '{"url":"http://127.0.0.1:4310/test-page"}'
$session
Invoke-RestMethod -Uri "http://127.0.0.1:4310/sessions/$($session.id)"
Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:4310/sessions/$($session.id)"
```

- `POST /sessions` → 201，包含 `id`、`status: starting` 和初始元数据。
- `GET /sessions/:id` → 当前真实状态；未知 ID → 404。
- `DELETE /sessions/:id` → 202，异步关闭 Context/Page；已终结 Session → 200。
- 非法 URL/JSON → 400，非 JSON 内容类型 → 415，Worker 不可用 → 503。
- URL 只允许 HTTP/HTTPS，禁止携带用户名密码。

## 实时协议

### Human Control 与 Control Lease

先 subscribe，再发送 `control-acquire`。Control 维护每 Session 唯一的 socket 所有权和随机 leaseId；先到者获得控制，不支持抢占。`control-state` 只向持有者发送 leaseId，其他客户端显示 CONTROLLED BY OTHER。即使复制了 leaseId，另一个 socket 也不能注入输入。

`control-release`、控制 socket 断开、Session 关闭/失败、Worker/Control 断开会撤销租约、清空队列并重置已按下的鼠标按钮与修饰键。重连/刷新恢复画面但不恢复租约，回到 VIEW ONLY。UI 状态还包括 REQUESTING CONTROL 和 CONTROL LOST。5 秒未收到输入结果会撤销控制；这不是固定时长租约。

### 输入协议与顺序

```ts
interface BrowserInput {
  type: 'browser-input';
  sessionId: string;
  pageId: string;
  leaseId: string;
  inputSequence: number;
  sourceFrameSequence?: number;
  input: InputAction;
}
```

`InputAction` 支持 pointer-move/down/up（left/middle/right、buttons、x/y）、wheel（x/y、deltaX/Y）、text（Unicode commit）、key（down/up/press、特殊键或修饰快捷键）。坐标以远端 viewport CSS 像素为单位，Control 与 Worker 校验边界、活动 pageId、Session 状态及递增序号。sourceFrameSequence 关联用户看到的帧，不提供历史帧重放或精确时序保证。

UI 与 Control 使用有界 InputBuffer（128 条），仅合并连续移动，保留离散事件顺序；一次仅一个输入在途。离散队列满时明确报错并释放控制。鼠标移动不进入 Timeline；离散 human-input 在 Playwright 注入前记录，包含 pageId/inputSequence/sourceFrameSequence，因此表示“尝试输入”，不是 DOM 已成功响应的证明。

文本使用独立 insertText，最多每块 4096 UTF-16 code units；中文 composition 在结束时提交，粘贴仅发送纯文本。Tab、Backspace、Enter、方向键及 Ctrl/Meta 快捷键走键盘链路。点击画面聚焦隐藏 textarea；仅接管画面阻止宿主页滚动，其他页面控件仍可使用。

### 文本隐私模型

输入原文仅为注入临时存在于 BrowserInput、内存队列和目标页面；human-input 的 text 分支只保存 `characterCount`（UTF-16 长度），不保存原文。输入失败和 auth 导入失败返回固定消息，避免 Playwright 异常附带参数；应用不主动打印输入或 Cookie。Cookie Header、认证文件和响应正文不进入 SessionEvent 或 Web UI。

此保证针对输入审计和本地 bootstrap 路径。浏览器 console、URL、pageerror 仍按 M1.1 记录真实内容；若目标站自行把输入/令牌打印到 console、放入 URL 或渲染在页面上，它可能进入事件或实时画面。M1.4 的 Evidence 会遮盖输入控件并净化 DOM，但没有通用 DLP，不能承诺任意第三方页面的秘密永不出现在所有 SessionEvent/画面中。普通输入框内容仍会自然出现在 Live View。

连接 `ws://127.0.0.1:4310/events`，发送：

```json
{"type":"subscribe","sessionId":"复制创建结果的 id"}
```

服务端先返回 `snapshot`（Session + 已有事件），随后单独发送当前 `browser-frame` 并继续推送 `state` / `event` / `browser-frame`。订阅和快照在同一事件循环中完成，避免订阅间隙。UI 自动重连并恢复快照；不轮询 REST。画面从不进入 `snapshot.events`。

每个 SessionEvent 都包含 `id`、`sessionId`、从 1 开始单调递增的 `sequence`、ISO `timestamp`、`type`、强类型 `payload`。`request`、`response`、`requestfailed` 用同一 Playwright Request 对象对应的稳定 `requestId` 关联，包括重定向中的独立请求。导航事件区分主 Frame；页面状态只使用主 Page URL/Title。

- navigation、request、response、requestfailed、console、pageerror、human-input **必须**带 `pageId`；Session 级 lifecycle 不带该字段，以 discriminated union 表达。
- 每个 Playwright Page 分配随机稳定 pageId，导航不改变身份；navigation.payload 包含自有稳定 `frameId` 和 `isMainFrame`，不依赖 CDP Frame ID。
- `activePageId` 初始为 null，首个 Page 创建后赋值；popup 拥有新 pageId，保留原活动页的画面、URL 和标题，没有 Tab Manager 或标签切换 UI。
- popup 首次请求可能早于 Playwright 发布 Page：短暂保留真实 Request 对象，Page 出现后通过 Frame 归属补发，不用 URL 猜身份。最多 1024 个待归属事件，超限终止该 Session。Service Worker 自有且无 Page 的网络请求不属于本阶段 Page 事件。
- console.payload 原样保存 `level`、`text`、`url`、`lineNumber`、`columnNumber`，协议位置为 Playwright 原始的 0-based 值，UI 显示时加 1。warning、第三方日志等不在 Worker 过滤；UI 筛选只改变显示。

独立帧格式：

```ts
interface BrowserFrame {
  type: 'browser-frame';
  sessionId: string;
  pageId: string;
  frameSequence: number;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  data: string; // base64
}
```

帧序号独立于 SessionEvent.sequence；帧不进入 Timeline、不进入事件历史、不持久化。浏览器 viewport 固定 1440 × 900，deviceScaleFactor=1；CDP JPEG quality=65。

## 背压、ACK 与画面生命周期

两种 ACK 相互独立：

1. Worker 收到 `Page.screencastFrame` 后立即 `Page.screencastFrameAck`，即使没有订阅者、丢帧或网络繁忙，也不会等待 UI。
2. Worker → Control 与 Control → UI 都使用应用级 `frame-ack`，包含 sessionId/pageId/frameSequence。Control 收到帧立即确认；UI 完成 JPEG 解码和 canvas 绘制后确认，解码失败或废弃帧也确认。后台标签页暂停绘制时传输自然暂停。

每个连接最多 **1 帧在途**，每个 Session 最多 **1 帧待发**，新帧覆盖旧待发帧。Worker 连接最多 100 个 Session 待发槽，UI 连接只允许 1 个。`bufferedAmount` 达到 256 KiB 时暂停发帧；帧 base64 上限 2 MiB，超限丢弃。Control 每个活跃 Session 只缓存一张当前帧，用于迟到订阅和静态页恢复。这些上限与持续运行时间无关；不会建立无限帧队列。

Session running 后才启动 screencast；close、活动 Page close/crash、Browser disconnect、Control disconnect、Worker shutdown 均停止 CDP 并移除监听器，释放 Context/Page。已崩溃 renderer 可能不响应停止命令，各清理等待有 750 ms 上限，仍继续 detach/关闭 Context。帧流启动/ACK 异常显示“画面暂时不可用”，保持事件链路，2 秒后尝试重新建立 CDP；终结 Session 时取消重试。

UI 提供等待、LIVE、已关闭、页面异常终止、暂时不可用状态；连接断开时不把旧画面标为 LIVE。

Session 状态：`starting → running → closed/failed`，启动/导航失败也可直接 `starting → failed`。HTTP 404/500 属于成功收到的真实 HTTP 响应，保留为 response；连接失败或导航超时导致 failed。页面 JavaScript 异常记录 pageerror，页面可继续运行。

## 测试与验收

```bash
pnpm typecheck
pnpm test
pnpm test:smoke
pnpm build
```

`pnpm test` 自动启动隔离端口上的真实服务与 Chromium，无需提前启动 `pnpm dev`，不依赖外部测试网站。覆盖：

- 独立 Context/Page、Cookie 与 localStorage 隔离、动态标题更新。
- Control 创建 → Worker 导航 → 五类事件 → WebSocket；请求/响应 ID 关联，序号严格递增。
- 后续导航的 URL/Title、迟到订阅补发、客户端断线与关闭 Session。
- 非法 URL/JSON、连接失败、导航超时、浏览器启动失败、Page crash/close、浏览器断开后重新启动。
- Worker 进程退出时活跃 Session 失败、503 与 Worker 重连恢复。
- 真实浏览器打开 React UI，创建 Session、展示状态与五类事件、关闭 Session、窄屏布局检查。
- JPEG 真实数据、尺寸、身份与单调 frameSequence；事件序号不受帧影响。
- 主 Page/Frame 导航身份稳定；popup 的初始请求/响应、导航和 warning 正确归属。
- 刷新 `/session/:id` 恢复 Session/Timeline/真实 canvas 帧，关闭/未知 Session 恢复提示，静态页迟到订阅。
- 慢 UI 和慢 Control 两层真实 WebSocket 测试：仅一帧在途、后续帧跳号；阻塞传输时 CDP 仍持续产帧，证明 ACK 不受消费者影响。
- 用真实 JPEG 进行 10,000 次队列替换，验证待发槽始终为 1；关闭后 CDP listener 数为 0、Context/Page 释放、帧停止。

`pnpm test:smoke` 单独运行跨进程与 React UI 链路；测试中的 fixture error 为预期现象。`pnpm build` 验证 Web 生产资源构建，本里程碑运行方式是 `pnpm dev`。

M1.3 另覆盖双客户端互斥、窃取/过期租约拒绝、无效坐标/pageId、真实三键点击、10,000 次移动合并、文本/IME/粘贴、特殊键、滑块、滚轮、刷新恢复只读、断开/关闭撤销、应用日志和 Timeline 隐私哨兵检查、auth origin/host 隔离。验收环境、32 项测试结果和交互式手工检查见 [Milestone 1.3 验收记录](docs/milestone-1.3.md)。

人工验收顺序：`pnpm install` → `pnpm typecheck` → `pnpm test` → `pnpm dev` → 打开 Web → 输入本地 fixture URL → Create Session → 确认真实状态与实时 Timeline。

M1.2 历史目标站验收：输入 `http://usercenter.tsatest.cn` → running → 查看真实登录页 → 复制 `/session/{id}` 并刷新 → 状态、Timeline、Live View 恢复 → 关闭 Session → 画面停止。外部网站仅用于人工验收，自动化测试始终使用本地 fixture。

## 错误处理与当前边界

- Session 失败/关闭会记录生命周期事件并释放 Page/Context；浏览器断开后后续 Session 可以重新启动浏览器。
- Control 断开时 Worker 关闭全部 Context；Worker 断开时 Control 将活跃 Session 标记 failed，并自动尝试重连。
- Control 对 Worker 使用 ping/pong；断开的 UI 不影响 Runtime，慢客户端断开后可重新订阅。
- 状态与事件仅存内存，服务重启不恢复；每 Session 保存最近 10,000 条事件，最多保留 100 个 Session，满额优先淘汰终结 Session，否则返回 429。UI 同样保留最近 10,000 条。
- 仅本机单用户开发工具，监听 `127.0.0.1`，不提供公网部署、认证、持久化、浏览器隔离安全边界或多 Worker 调度。输入 URL 会由本机 Chromium 访问，包括本地网络地址。
- 仅支持原活动 Page 的鼠标/键盘输入；没有 popup 控制、触摸、文件上传、原生对话框、系统剪贴板读取或跨设备完整 IME 保证。Meta 快捷键未在本次 Windows 环境进行 macOS 人工验收。
- CAPTCHA：未解决，且不阻塞 M1.3 本地 fixture 验收。headless/headed 均不保证第三方人机验证通过；复用已有登录状态只用于后续本地诊断。本次收尾不调查或修复 CAPTCHA。
- Live View 帧仅在内存传输，M1.4 Evidence 独立落盘；不实现 Video、HAR、请求/响应 Body、Cookie/Storage snapshot、AI/LLM/Agent、Finding、Replay、Regression 产品能力、Jira、数据库、Redis、S3/OSS/MinIO、WebRTC、Multi-agent 或通用认证/DLP 系统。仓库回归测试不属于产品 Regression 功能。


## M1.4 Action & Evidence

`Raw BrowserInput != Action`、`SessionEvent != Action`、`BrowserFrame != EvidenceSnapshot`。Runtime 的 ActionRecorder 在 PageInput 校验通过后、首次真实注入前识别目标并捕获 Before。目标只含短语义描述，不含 value/outerHTML，不是可回放 locator。actor 模型预留 human/agent/replay，目前仅 human。

| 输入 | Action 归并 |
| --- | --- |
| down/up | 首尾距离 ≤6 CSS px 为 click（左/中/右）；>6 为 drag，记录起止位置 |
| pointer-move | 永不单独生成 Action；移动洪泛仍由 M1.3 有界队列合并 |
| text | 500ms idle 内连续提交合并 type；只记录 UTF-16 characterCount |
| wheel | 250ms idle 内合并 scroll，记录累计 deltaX/Y 与 eventCount |
| key | modifier 不单独记录；非 modifier down/up 或 press 形成 key，保留 modifiers |

新的离散操作在开始前结束旧的 text/scroll。输入完成后 settle：至少 150ms，相关请求结束且 200ms 安静窗口，上限 2000ms；达到上限也完成并标记 timedOut，不使用全页面 networkidle。请求以 requestfinished/requestfailed 结束判定，响应头到达不等于请求体已结束。前一 Action 的 After 完成后才开始下一离散 Action 的 Before，因此证据增加有界延迟；捕获和文件写入有独立超时，失败不会阻止输入。

Action 有独立 UUID、时间、状态 recording/completed/interrupted、Before/After refs、eventSequenceStart/End、networkRequestIds 和 evidenceStatus。输入注入前的 human-input 位于事件范围内；结束前发起的请求用 requestId 关联，即使响应晚于 eventSequenceEnd 仍显示。该关系是时间关联，不是严格因果推断；旧事件被 10,000 条历史上限淘汰后可能无法显示详情。

### Evidence 和隐私

每个 Snapshot 保存独立 UUID、session/action/page ID、phase、时间、URL、title 和 viewport。截图是真实 Page 的原 viewport JPEG（quality 80）；DOM 为 document clone 净化后文本。ArtifactRef 仅含 UUID、kind、contentType、byteLength、SHA-256，没有磁盘路径或 base64。

- 截图遮盖文本类 input（包含默认无 type）、textarea、contenteditable，并整体遮盖 iframe/frame；checkbox/radio/button/range/color 等非文本控件保留。Live View 不做此遮盖。
- DOM 移除 script/style/noscript/template、注释、iframe/frame/object/embed、on*、style、srcdoc；input value、textarea/select/contenteditable 内容以及敏感属性统一脱敏，data-* 仅保留 data-testid/data-test/data-cy。Shadow DOM 不序列化。
- 页面上其他普通业务内容仍会进入持久化 screenshot；M1.4 不是通用 DLP 系统。网页若将秘密复制到普通文本、URL、语义标签或 console，不能承诺全部清除。测试 fixture 验证表单原文和秘密哨兵未落入 DOM，截图对应控件为遮盖色。
- 不保存 Cookie、LocalStorage、SessionStorage、Authorization Header、请求/响应 Body、HAR 或 Video。原有 scoped auth bootstrap 仍仅为本地诊断辅助。

### ArtifactStore、上限与生命周期

`@repropath/artifacts` 定义 put/read 接口；LocalArtifactStore 默认目录为 `~/.repropath/artifacts/`，Worker 与 Control 必须使用同一个 `REPROPATH_ARTIFACT_DIR` 覆盖值（若设置）。测试显式覆盖到忽略的 test-results；产品默认在仓库外。

文件使用生成 UUID，以独占临时文件写入后 rename。单进程串行写入，最多 64 个待写任务。失败保留已有文件。控制端只允许读取当前 Action 索引引用的 UUID，并校验长度/hash；未知、未引用、路径穿越或损坏文件返回 404。

| 限制 | 行为 |
| --- | --- |
| 500 Action metadata / Session | 保留最近 500；旧引用失去 API 访问资格 |
| 前 500 个 Action / Session 保存证据 | 后续仍记录 Action，跳过新截图/DOM，标记 partial |
| 256 MiB / Session | 证据写入预留预算，超限继续输入但证据不完整 |
| DOM 5 MiB、JPEG 8 MiB / Snapshot | 超限不保存该 artifact |
| Artifact 目录 2 GiB / 50,000 文件 | 包含重启前遗留文件；达到上限拒绝新写入，不自动删除旧证据 |

Session close 保留 Action 和 Evidence；关闭/租约撤销/Worker 丢失时未完成 Action 标记 interrupted。Control/Worker 重启不恢复 Session/Action 索引，文件可能残留但不可通过 API 读取。没有数据库、远端存储或自动清理工具；达到目录上限后由本机用户管理旧文件。临时写入/超时或 metadata 淘汰也可能留下不可访问文件，仍计入磁盘上限。

### API 和 UI

- `GET /sessions/:sessionId/actions`：最近 Action 列表（包含摘要和 refs）。
- `GET /sessions/:sessionId/actions/:actionId`：完整 Action；未知返回 404。
- `GET /artifacts/:artifactId`：只读取被引用的 artifact，Cache-Control: no-store、nosniff。DOM 为 text/plain; charset=utf-8，图片为 image/jpeg。
- 独立 `action-update` 从 Worker 经 Control 实时推送；WS 重连通过 REST 恢复历史，不把 Actions 塞入事件 snapshot。

Live Session 下的 Actions 列表显示 actor/kind/target/时间/耗时/证据状态/请求及错误数。展开可看 Before/After、相关网络和 console/page 事件；DOM 仅在 `<pre>` 中作为文本显示。partial/failed 显示 Evidence incomplete。关闭后的 Session 仍可展开证据。

完整 M1.4 测试及人工验收见 [milestone-1.4.md](docs/milestone-1.4.md)。本阶段到此为止，不进入 M2/Agent 开发。CAPTCHA 仍未解决、不阻塞本地 fixture 验收，本次未处理。
