# ReproPath · Milestone 1.1

当前目标：把真实 Chromium 中发生的事件稳定传递到网页 Timeline，建立最小 Browser Runtime。所有浏览器事件均来自 Playwright，没有 mock 事件。

> Milestone 1.1 does not implement AI, browser screencast, human takeover, evidence recording, replay, or regression testing.

## 架构与目录

```text
Browser (Playwright Chromium, 独立 Context + Page / Session)
  → Browser Worker → SessionEvent → Control → WebSocket → React UI

apps/
  web/             React + Vite，创建 Session、状态与实时 Timeline
  control/         HTTP API、Session 状态/历史、WebSocket 订阅、本地 fixture
  browser-worker/  独立进程，Chromium 生命周期和原生事件采集
packages/
  protocol/        Zod 运行时校验与 TypeScript 通信类型
tests/             真实浏览器 Runtime 与跨进程/UI smoke tests
pnpm-workspace.yaml
package.json
```

应用之间不 import 彼此实现；只依赖 `@repropath/protocol`。Worker 监听私有本机 WebSocket，Control 主动连接并发送 start/close 命令，接收状态和事件；UI 只连接 Control。测试可以直接测试 Worker 的公开 Runtime 类。

## 环境与安装

- Node.js 22.12+ 或 Node.js 24+，pnpm 10（项目声明 10.17.1）。
- Windows、macOS 或 Playwright 支持的 Linux；首次安装需要访问 npm 与 Playwright 浏览器下载地址。
- 在项目根目录执行：

```bash
pnpm install
```

根项目 `postinstall` 自动执行 `playwright install chromium`，安装与锁定 Playwright 版本匹配的 Chromium。Linux 如缺少系统动态库，先执行 `pnpm exec playwright install-deps chromium`（需要系统管理员权限）。浏览器安装机制参见 [Playwright 官方文档](https://playwright.dev/docs/browsers)。

## 启动

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

打开 Web UI，输入 `http://127.0.0.1:4310/test-page`，点击 **Create Session**。应看到 Session ID、`running`、真实 Current URL / Page Title，以及 NAVIGATION、REQUEST、RESPONSE、CONSOLE、PAGE ERROR。

本地 fixture 加载后自动打印日志、请求 `/fixture/api/user` 并抛出未捕获异常。页面也提供 Request API、Console Log、Throw Error、Navigate 按钮。使用 `http://127.0.0.1:4310/test-page?navigate=1` 会自动导航到 `/test-page/next`，可观察 URL 和标题变化。直接在个人浏览器打开 fixture 的按钮只操作那个浏览器；本版本没有远程操作 Worker 的能力，因此人工验收 Worker 使用自动触发流程。

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

服务端先返回 `snapshot`（Session + 已有事件），随后推送 `state` / `event`。订阅和快照在同一事件循环中完成，避免创建后才订阅导致早期事件丢失。UI 自动重连并恢复快照；不轮询 REST。

每个 SessionEvent 都包含 `id`、`sessionId`、从 1 开始单调递增的 `sequence`、ISO `timestamp`、`type`、强类型 `payload`。`request`、`response`、`requestfailed` 用同一 Playwright Request 对象对应的稳定 `requestId` 关联，包括重定向中的独立请求。导航事件区分主 Frame；页面状态只使用主 Page URL/Title。

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

`pnpm test:smoke` 单独运行跨进程与 React UI 链路；测试中的 fixture error 为预期现象。`pnpm build` 验证 Web 生产资源构建，本里程碑运行方式是 `pnpm dev`。

人工验收顺序：`pnpm install` → `pnpm typecheck` → `pnpm test` → `pnpm dev` → 打开 Web → 输入本地 fixture URL → Create Session → 确认真实状态与实时 Timeline。

## 错误处理与当前边界

- Session 失败/关闭会记录生命周期事件并释放 Page/Context；浏览器断开后后续 Session 可以重新启动浏览器。
- Control 断开时 Worker 关闭全部 Context；Worker 断开时 Control 将活跃 Session 标记 failed，并自动尝试重连。
- Control 对 Worker 使用 ping/pong；断开的 UI 不影响 Runtime，慢客户端断开后可重新订阅。
- 状态与事件仅存内存，服务重启不恢复；每 Session 保存最近 10,000 条事件，最多保留 100 个 Session，满额优先淘汰终结 Session，否则返回 429。UI 同样保留最近 10,000 条。
- 仅本机单用户开发工具，监听 `127.0.0.1`，不提供公网部署、认证、持久化、浏览器隔离安全边界或多 Worker 调度。输入 URL 会由本机 Chromium 访问，包括本地网络地址。
- 不收集响应正文、截图、录像、证据；不实现 LLM、AI Agent、MCP、Finding、Diagnosis、Replay、Regression、Semantic Test、Jira、CI/CD、Kubernetes、Multi-Agent、Vector DB、Knowledge Graph、Browser live video 或 Remote mouse/keyboard。
