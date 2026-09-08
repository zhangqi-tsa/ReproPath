# Milestone 1.3 — Interactive Human Control 验收记录

验收日期：2026-09-08（Asia/Shanghai）。范围仅为已有 M1.3 实现的收尾验证、隐私断言和文档；本次未增加产品功能，也未修改 CAPTCHA 行为。

## 环境

- Windows / PowerShell，Node.js 24.6.0，pnpm 10.17.1。
- Playwright 1.55.1，Chromium 140.0.7339.186（revision 1193）；Vite 7.3.6。
- 仓库：`D:\Documents\ReproPath`；开始收尾时工作树干净，基线提交 `255ddd7`。
- 全量测试自建隔离端口的 Worker、Control、Vite 和 Chromium，仅访问本地 fixture。
- 交互式人工检查由 Codex 通过浏览器 UI 工具逐项操作并检查可见 Timeline，独立于测试脚本；不是用户亲自签署的 UAT。Web `127.0.0.1:5174`、Control `127.0.0.1:4320`、Worker `127.0.0.1:4321`，目标 `/test-page/control`，远端 viewport 1440×900，UI 为窄窗口。
- 检查 Session：`a9da318a-7514-4844-8a36-6745a5239ee7`，已在验收末尾关闭。未操作现有目标站登录 Session。

## 全量回归

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | PASS，根目录及全部五个 workspace 包 |
| `pnpm test` | PASS，32 tests / 32 pass / 0 fail / 0 skipped / 0 cancelled |
| `pnpm build` | PASS，Web 生产资源构建 |

Node test runner 的 32 计数包含父测试。分组：Human Control 10（父项及 9 个子项）、Runtime 7、启动失败 1、auth 隔离 1、跨进程 smoke 11、帧背压/清理 2。

M1.1/M1.2 原有测试保持并通过：Context/storage 隔离、五类事件、请求关联、导航/标题、页面与浏览器失败、Worker 恢复、真实 JPEG、Page/Frame 身份、popup 归属、刷新恢复、慢消费者背压、CDP ACK 与监听器清理。对比 M1.2 提交 `0e1705c`，tests 只有新增内容，没有删除既有用例。测试内预期的超时、崩溃、缺失浏览器可执行文件日志不是未处理的验收失败。

初始环境默认 pnpm 11 不符合项目 engines，未执行检查；改用指定 pnpm 10.17.1 的工作区缓存。沙箱内 Chromium 启动受限的尝试未算通过；获准在本机执行后完成全量回归。没有放宽项目版本要求或跳过浏览器测试。

## 交互式人工验收

| 操作 | 实测结果 |
| --- | --- |
| acquire control | VIEW ONLY → HUMAN CONTROL |
| 左键点击 | `remote-click-ok`，随后真实 fixture API request/response |
| 右键点击 | `remote-right-ok` |
| 中键点击 | `remote-middle-ok`，fixture 禁用中键自动滚屏 |
| drag / slider | 连续拖动，slider-value 从 18 经 37/65/74 到 92 |
| wheel / remote scroll | wheel Δy=1923，`remote-scroll-ok`；Live View 外的宿主界面未随远端滚动 |
| ASCII | 8 字符文本提交，`input-length: 8` |
| Chinese Unicode | Ctrl+A 后提交 4 个汉字，`input-length: 4` |
| paste | Tab 到第二输入框后粘贴 5 字符，`input-length: 5` |
| Tab | `special-key: Tab`，`focus: second` |
| Backspace | 4 字符变为 3，`special-key: Backspace` |
| Enter | `enter-length: 3` 和 `form-submit-length: 3`；仅本地 fixture 表单，未提交外部业务 |
| Ctrl+A | ASCII 被后续中文整体替换；Windows 使用 Control，Meta/macOS 不在本次人工环境内 |
| release control | HUMAN CONTROL → VIEW ONLY |
| release 后继续操作 | 点击和输入未增加 Timeline，保持 54 条事件 |
| controlling 时刷新 | 相同 Session 恢复 LIVE / VIEW ONLY，租约未恢复 |
| 两个客户端 | A 为 HUMAN CONTROL，B 为 CONTROLLED BY OTHER；B 点击不产生输入事件。自动化另验证 B 请求租约被 CONTROL_BUSY 拒绝及窃取 token 无效 |
| Session close | A 持有控制时关闭，变为 closed / VIEW ONLY，接管按钮不可用，追加 closed lifecycle；自动化另验证残留输入被 SESSION_NOT_RUNNING 拒绝 |

以上全部通过。自动化另覆盖 390×844 映射、IME composition-end 提交、移动洪泛、无效坐标/序号/pageId、popup 输入拒绝、断开释放与 Worker 失败撤销。中文人工检查使用浏览器工具的 Unicode 提交，不声称验证了所有操作系统 IME 候选窗口。

## 安全与隐私核查

- 本地 fixture 的原始 ASCII、中文、粘贴输入未出现在 SessionEvent；human-input text 仅记录 UTF-16 `characterCount`，普通字符不会逐键记录。pointer-move 不写事件。
- 自动化为 scoped auth 配置非真实 Cookie 哨兵，并扫描非帧 WS 消息、Web UI 元数据/Timeline、Worker/Control/Vite stdout/stderr；输入原文和 Cookie 哨兵均未出现。auth 独立测试确认真实 Cookie 导入、origin 不匹配不导入、子域请求不携带 host-only Cookie、错误提示不含值。
- 实际本地 auth 文件位于仓库外；`git ls-files` 未跟踪 auth JSON。只输出计数的扫描确认全部 Git 跟踪文件中实际 Cookie 值命中数为 0；凭据未复制进验收文档或测试文件。
- 原始文本为实际注入仍需短暂经过输入协议和内存队列；它不会由输入审计或应用主动写入日志。认证配置不经过 Control API，不出现在 UI 配置或 Timeline 中。

**保证边界：**上述“未出现”基于本地 fixture 和输入/auth 实现路径，不能推广为任意第三方页面的绝对保密承诺。M1.1 仍采集页面 console、URL、pageerror；若网站自己打印秘密或在页面显示它，可能进入 SessionEvent 或 Live View。输入框本身的文字也会显示在实时画面中。本阶段没有通用内容脱敏器；本次未为满足绝对措辞新增该功能。

## 架构摘要

1. 浏览器事件：Playwright → Worker → Control → WebSocket → Timeline。
2. 画面：CDP screencast → 独立 BrowserFrame → 两层有界 latest-frame sender → Canvas。CDP 与应用帧 ACK 分离。
3. 输入：UI → BrowserInput → Control socket-owned Lease 校验/排队 → Worker PageInput → Playwright mouse/keyboard → InputResult。

BrowserInput 包含 sessionId/pageId/leaseId、递增 inputSequence、可选 sourceFrameSequence 和 input。Control 保证每 Session 单一持有者，token 不能跨 socket 使用。移动仅合并连续尾部事件；离散事件保序，128 条有界缓冲，溢出/输入超时撤销控制。Worker 二次检查活动页、状态、坐标与序号；input-reset 使排队输入失效并释放按住的键和鼠标。

human-input 在注入前写入，仅说明输入尝试；成功结果和目标 DOM 效果需另观察。sourceFrameSequence 是关联信息，不代表精确帧时序或回放能力。刷新不保存 leaseId，断开/终止时释放。默认只读，隐藏 textarea 承接文本和 IME，画面内 wheel 阻止宿主滚动。

## 诊断辅助与已知限制

- `pnpm dev:headed` 使用可见 Chromium 进行本机对照。直接操作该窗口不经过远程 Lease/human-input 审计；不能将其当作远程控制权限边界。
- scoped auth import 仅为**本地诊断/bootstrap**：显式 auth 文件、请求 origin 完全匹配、host-only 会话 Cookie、SameSite=Lax、按 HTTPS 设置 Secure。请求头不包含原始 Cookie 属性，因此不会恢复 HttpOnly、Path、过期时间，也不迁移 localStorage；没有账号管理、持久化认证库、续期或通用认证系统。
- **CAPTCHA：UNRESOLVED / NON-BLOCKING。**此前普通 Chrome 成功、ReproPath headless/headed 失败；根因未确认。本地 fixture 的 M1.3 人工接管验收不依赖第三方 CAPTCHA，复用既有登录态不等于修复验证码。本次没有调查、提交或修复 CAPTCHA。
- 只控制原活动 Page；不支持 popup 切换控制、touch、文件上传、原生对话框或完整跨系统 IME 验证。
- 状态/历史/帧仅内存保存，重启不恢复；最近 10,000 条事件、最多 100 个 Session。服务仅为本地开发工具，没有公网认证、多 Worker 调度或安全隔离保证。
- 不实现 AI、Evidence、Replay、Regression 产品功能、数据库或通用认证。现有仓库回归测试及 QA 截图属于开发验证。

## 收尾范围

本次提交只更新 README、此验收记录和现有测试的隐私断言。产品实现沿用 `255ddd7`，package version 保持原值，不以版本号替代里程碑验收。提交后用 `git status --porcelain` 核验工作树；忽略的 test-results 缓存/QA 文件不属于待提交文件。
