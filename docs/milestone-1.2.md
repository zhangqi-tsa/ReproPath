# Milestone 1.2 验收记录

日期：2026-09-07。运行环境：Windows、Node.js 24.6.0、pnpm 10.17.1、Playwright 1.55.1 配套 Chromium。

## 自动化验收

`pnpm typecheck`、`pnpm test`（20/20）、`pnpm build` 通过；`pnpm dev` 的 Web、Control、Worker 均正常运行。

| 要求 | 验证 |
| --- | --- |
| 真实 CDP 画面 | JPEG magic bytes、非空、1440 × 900、正确 Session/Page、递增 frameSequence、真实 canvas 像素 |
| 事件与帧独立 | BrowserFrame 无法解析为 SessionEvent；snapshot.events 与 Timeline 无帧 |
| Page/Frame identity | 连续导航前后主 Page/Main Frame ID 相同；popup 的导航、初始 request/response、warning 归属新 Page |
| URL restore | 创建后 `/session/:id`；真实浏览器 reload 恢复 ID、URL、Title、Timeline、canvas；静态页当前帧恢复 |
| 背压 | 慢 UI、慢 Control 均仅一帧在途，ACK 后收到跳号的最新帧；快客户端不被阻塞 |
| 有界内存结构 | 10,000 次真实 JPEG 帧替换，待发槽始终 1；CDP 在无传输 ACK 时持续产帧 |
| 清理 | Session close 后帧停止、Context/Page 释放、CDP 帧监听器为 0；崩溃时 CDP 停止等待有上限 |
| 错误路径 | 保留 M1.1 非法 URL、连接失败、超时、Page/Browser crash、Worker 退出与恢复测试 |

默认测试只使用本地 fixture。测试中的 pageerror、超时与 missing executable 日志来自预期失败场景。

## 指定外部站点验收

通过 Web UI 创建 `http://usercenter.tsatest.cn`，没有提交登录表单或转发输入：

- Chromium 导航到 `http://usercenter.tsatest.cn/login`，真实标题为“登录”。
- Canvas 中可见实际登录页面；观察期间 frameSequence 从 2 增加到 22。
- 同时收到 310 条 Timeline 事件。
- 刷新 `/session/:id` 后 Session ID、Page ID、URL、Title、Timeline 与 LIVE 画面恢复。
- 点击“关闭 Session”后显示“浏览器 Session 已关闭”，画面停止。

当次验收日志及 Web UI 视觉检查图片位于被 Git 忽略的 `test-results/`。这些仅为开发验证输出，不是运行时的截图、录像或证据存储功能。

## 范围

只读画面；不转发鼠标、键盘、滚动。没有 Tab Manager、数据库、AI、录像或证据系统。状态、事件和一张当前帧只保存在当前 Control 进程内存，重启后丢失。
