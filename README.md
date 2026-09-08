# ReproPath · Milestone 1.2 — Live Browser View

当前目标：在 Web UI 中实时观察 Session 内真实 Chromium Page 的只读画面，同时保留独立的浏览器事件 Timeline。浏览器事件来自 Playwright，画面来自 CDP screencast；不使用预制图片或定时 screenshot。

M1.1 的历史边界（M1.2 仅新增只读 screencast，不扩展其余项目）：

> Milestone 1.1 does not implement AI, browser screencast, human takeover, evidence recording, replay, or regression testing.

## 架构与目录

```text
Chromium (独立 Context / Session，明确 1440 × 900 viewport)
  ├─ Playwright Events → SessionEvent → Control → WebSocket → Timeline
  └─ CDP Screencast → BrowserFrame → Control → WebSocket → Canvas Live View

apps/
  web/             React + Vite，只读画面、URL 恢复、状态与 Timeline
  control/         HTTP API、事件历史、当前帧缓存、WebSocket、本地 fixture
  browser-worker/  Chromium 生命周期、Page/Frame 身份、CDP screencast
packages/
  protocol/        Zod 运行时校验与 TypeScript 通信类型
  streaming/       Worker/Control 共用的 latest-frame-wins 有界发送器
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

可选本地登录状态导入：设置 `REPROPATH_AUTH_FILE` 为仓库外 JSON 文件的绝对路径，格式为 `{"origin":"https://your-site.example","cookieHeader":"session=your-value"}`。仅当新 Session 的请求 origin 完全匹配时，Worker 才会在首次导航前导入 Cookie；现有 Session 不受影响。文件不得提交到 Git。请求 Cookie 不包含原属性，导入采用 host-only、会话有效期、SameSite=Lax，并按 HTTPS 设置 Secure；不恢复 Local Storage，不复制到其他子域。关闭 Session 清除其 Context；取消环境变量可停止后续导入。加载错误只返回固定提示，不输出凭据。

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

打开 Web UI，输入 `http://127.0.0.1:4310/test-page`，点击 **Create Session**。地址变成 `/session/{id}`，应看到 `running`、真实 Current URL / Page Title、Active Page ID，以及 **● LIVE** 的浏览器画面和五类事件。画面按 1440 × 900 坐标系等比缩放，鼠标、键盘、滚动均不会转发到 Worker。

复制该地址或刷新网页会先 `GET /sessions/:id`，然后 WebSocket subscribe → snapshot → 当前帧 → 后续事件/帧，无需重新创建 Session。静态页面也可恢复最后一帧。只有 Control 当前进程仍保存的 Session 可以恢复；未知或已淘汰 ID 显示明确提示。已关闭 Session 可以恢复状态和 Timeline，但不再显示旧画面。

本地 fixture 加载后自动打印日志、请求 `/fixture/api/user` 并抛出未捕获异常。页面也提供 Request API、Console Log、Throw Error、Navigate 按钮。使用 `http://127.0.0.1:4310/test-page?navigate=1` 会自动导航到 `/test-page/next`，可观察 URL 和标题变化。直接在个人浏览器打开 fixture 的按钮只操作那个浏览器；本版本没有远程操作 Worker 的能力，因此人工验收 Worker 使用自动触发流程。

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

连接 `ws://127.0.0.1:4310/events`，发送：

```json
{"type":"subscribe","sessionId":"复制创建结果的 id"}
```

服务端先返回 `snapshot`（Session + 已有事件），随后单独发送当前 `browser-frame` 并继续推送 `state` / `event` / `browser-frame`。订阅和快照在同一事件循环中完成，避免订阅间隙。UI 自动重连并恢复快照；不轮询 REST。画面从不进入 `snapshot.events`。

每个 SessionEvent 都包含 `id`、`sessionId`、从 1 开始单调递增的 `sequence`、ISO `timestamp`、`type`、强类型 `payload`。`request`、`response`、`requestfailed` 用同一 Playwright Request 对象对应的稳定 `requestId` 关联，包括重定向中的独立请求。导航事件区分主 Frame；页面状态只使用主 Page URL/Title。

- navigation、request、response、requestfailed、console、pageerror **必须**带 `pageId`；Session 级 lifecycle 不带该字段，以 discriminated union 表达。
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

人工验收顺序：`pnpm install` → `pnpm typecheck` → `pnpm test` → `pnpm dev` → 打开 Web → 输入本地 fixture URL → Create Session → 确认真实状态与实时 Timeline。

M1.2 目标站验收：输入 `http://usercenter.tsatest.cn` → running → 查看真实登录页 → 复制 `/session/{id}` 并刷新 → 状态、Timeline、Live View 恢复 → 关闭 Session → 画面停止。外部网站仅用于人工验收，自动化测试始终使用本地 fixture。

## 错误处理与当前边界

- Session 失败/关闭会记录生命周期事件并释放 Page/Context；浏览器断开后后续 Session 可以重新启动浏览器。
- Control 断开时 Worker 关闭全部 Context；Worker 断开时 Control 将活跃 Session 标记 failed，并自动尝试重连。
- Control 对 Worker 使用 ping/pong；断开的 UI 不影响 Runtime，慢客户端断开后可重新订阅。
- 状态与事件仅存内存，服务重启不恢复；每 Session 保存最近 10,000 条事件，最多保留 100 个 Session，满额优先淘汰终结 Session，否则返回 429。UI 同样保留最近 10,000 条。
- 仅本机单用户开发工具，监听 `127.0.0.1`，不提供公网部署、认证、持久化、浏览器隔离安全边界或多 Worker 调度。输入 URL 会由本机 Chromium 访问，包括本地网络地址。
- 画面仅在内存实时传输；不实现 Evidence storage、Video recording、Screenshot evidence、Remote mouse/keyboard/scroll、Human takeover、AI/LLM/Agent、Finding、Replay、Regression、Jira、数据库、Redis、Kubernetes、WebRTC 或 Multi-agent。测试生成的 Web UI 截图仅用于界面 QA，不是产品证据功能。
