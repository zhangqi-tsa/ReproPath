# Milestone 1.4 — Action & Evidence Recorder

验收日期：2026-09-08（Asia/Shanghai）。分支 `feat/milestone-1.4`，基于已合并 M1.3 的 `main`（`c10e1fe`）。本阶段只实现人工 Action 归并与本地 Evidence，不进入 M2、Agent、Finding、Replay 或 Regression 产品开发。

## 模型与链路

```text
BrowserInput → Control Lease → Runtime PageInput 校验
                                  ↓
                            ActionRecorder
                                  ├ Before: target + masked Page screenshot + sanitized DOM
                                  ↓
                            Playwright input
                                  ├ human-input / request / response / console / navigation
                                  ↓
                            bounded settle
                                  └ After: masked Page screenshot + sanitized DOM

Worker action-update → Control ActionStore → WebSocket + REST → Actions UI
ArtifactStore.put → LocalArtifactStore → UUID files
Control known Action refs → ArtifactStore.read → /artifacts/:id
```

Action 是独立一级对象，不是 SessionEvent、inputSequence 或 BrowserFrame。`ActionRecordSchema` 包含 UUID、sessionId/pageId、actor、kind、status、起止时间/耗时、sourceFrameSequence、target、detail、Before/After、事件序号范围、networkRequestIds、settle 和 evidenceStatus。actor 预留 human/agent/replay，仅 human 有实现。

Target 在注入前用 elementFromPoint 或 activeElement 获取：tagName、role、ariaLabel、name、type、testId 和最多 120 字符的非输入元素文本。表单/contenteditable 不读取内容，不保存 value/outerHTML；失败时省略，不影响输入。它是辅助描述，不是定位器。

## 归并规则

| 原始输入 | 结果 |
| --- | --- |
| pointer down/up，首尾距离 ≤6 CSS px | 一个 click，记录 button/x/y |
| pointer down/up，首尾距离 >6 CSS px | 一个 drag，记录 button 与起止坐标 |
| pointer move | 不生成独立 Action，保留 M1.3 移动合并与离散输入顺序 |
| 连续 text，500ms idle 内 | 一个 type，只累计 UTF-16 characterCount；IME/粘贴同样走 text |
| 连续 wheel，250ms idle 内 | 一个 scroll，累计 totalDeltaX/Y 与 eventCount |
| 非 modifier key down/up 或 press | 一个 key，记录 key/modifiers；modifier 本身不生成 Action |

新的离散类型在注入前结束已有 Action；原始 human-input 审计保留。归并定时任务绑定其 Action 身份，旧任务不能结束后来的 Action。租约重置、关闭或失败将仍 recording 的 Action 标为 interrupted，已有 Before 保留；Worker 丢失时 Control 同样终止悬挂记录。

## Before、After 与 settle

Before 完成或失败后才注入该 Action 的第一个输入。After 等输入完成后捕获，settle 至少 150ms，相关请求无待结束项且 200ms 安静才结束，上限 2000ms。相关请求在 requestfinished/requestfailed 时退出等待，不以 response headers 代替完整请求结束。console/pageerror/navigation 也刷新安静窗口。持续请求或长请求达到上限时仍 completed，settle.timedOut=true；不调用全页面 networkidle。

下一离散 Action 的 Before 会等上一 Action 的 After 结束，防止下一次输入污染上一个现场。截图超时 500ms、DOM 提取 500ms、target 150ms、title 100ms、每次存储等待 250ms；失败降级为 partial/failed。证据会增加输入延迟，但不会无限等待或因写入失败阻止真实输入。单 Session 内输入仍经既有有界队列和 lease 屏障。

Snapshot 记录捕获时间、URL、title、viewport 和独立 refs；DOM 与 JPEG 并发获取，不保证快速变化页面上两者是原子同一时刻。before/after 是真实 Page 现场，不是 Live View canvas 的截图。

## Evidence 与脱敏

- Screenshot：真实 `page.screenshot`，JPEG quality=80，原 viewport 1440×900，非 fullPage，隐藏 caret。默认 mask 文本类 input（包括未声明 type）、textarea、contenteditable 和整个 iframe/frame；非文本 checkbox/radio/button/range/color 可保留。
- DOM：在页面中 clone document 后净化，移除 script/style/noscript/template、注释、iframe/frame/object/embed、on*、style、srcdoc。input value、textarea/select/contenteditable 内容替换为 `[REDACTED]`；属性名匹配 password/passwd/secret/token/auth/cookie/session/credential/api-key/apikey 同样替换。data-* 仅保留 data-testid/data-test/data-cy。Shadow DOM 不序列化。
- ArtifactRef：UUID、kind、contentType、byteLength、SHA-256；消息没有本机路径或截图 base64。
- 不保存 Cookie、LocalStorage、SessionStorage、Request/Response Body、Authorization Header、HAR、Video。

原始 BrowserInput.text 不进入 Action detail、人类输入 SessionEvent、应用主动日志或 artifact 文件名；本地 fixture 的输入原文和秘密哨兵未进入 Sanitized DOM。截图 mask 覆盖相应表单区域，像素测试检查遮盖色。

**隐私边界：页面上其他普通业务内容仍会进入持久化 screenshot；M1.4 不是通用 DLP 系统。** 如果页面把用户内容回显到普通文本、语义标签、URL 或 console，无法保证所有副本被清除。原始 Timeline 继续采集真实页面事件，Live View 仍显示实际页面；不对第三方网站作全面保密承诺。HTML clone 的净化也不是完整可执行 HTML 安全沙箱，因此 DOM 绝不按 HTML 提供或渲染。

## ArtifactStore 与生命周期

`packages/artifacts` 提供可替换的 ArtifactStore put/read 接口，本阶段只有 LocalArtifactStore。默认 `~/.repropath/artifacts/`，`REPROPATH_ARTIFACT_DIR` 可覆盖，Worker/Control 必须指向相同目录。测试明确覆盖到 test-results，生产默认目录不在仓库内。

每次生成 UUID，以 UUID.tmp 独占写入并 rename 成 UUID；不使用 URL/title/target 作为文件名。串行写入、最多 64 个待写任务。写入失败不覆盖或删除已存在证据；异步写入超时可能留下无引用文件，计入目录上限。

| 上限 | 实施方式 |
| --- | --- |
| 500 metadata / Session | Control/UI 保留最近 500，淘汰项不再授权 artifact API |
| 前 500 Action / Session 捕获证据 | 后续 Action 仍生成，跳过新截图/DOM并标记 partial |
| 256 MiB / Session | 先预留字节预算，失败/超时预留不退回，保守限制晚到写入 |
| DOM 5 MiB / Snapshot | 超出不写该文件 |
| JPEG 8 MiB / Snapshot | 超出不写该文件 |
| 目录 2 GiB、50,000 文件 | 包括历史/临时文件，重启不会绕过目录预算 |

上限不阻止浏览器操作，不自动清除旧证据。Session close 保留 refs 和文件；Control/Worker 重启不恢复 Session/Action 索引，文件可能残留但无法通过 API 读取。没有数据库、对象存储或历史恢复/垃圾回收服务。默认单 Worker、本机工具；不支持多个独立进程并发共用目录作分布式配额管理。

## 网络和事件关联

Recorder 记录当前 Action 期间在活动 Page 发起的 requestId，最多 1000 个。UI 用 requestId 关联 REQUEST/RESPONSE/REQUESTFAILED，所以晚于 eventSequenceEnd 的慢响应仍可显示。console/pageerror/navigation 通过 pageId 与闭合事件序号范围展示。human-input 位于 Action 范围内；Action 自己不抢占 SessionEvent sequence。

此关联是时间相关性，不声称因果推断。此前已在飞行的请求不纳入该 Action，独立 popup 不作为当前活动 Page 的证据目标。原始事件历史仍有 10,000 条上限，淘汰后可能只剩 requestId 而无法展开历史响应。

## API 与 UI

- `GET /sessions/:id/actions`：最近列表，包含摘要字段和 refs。
- `GET /sessions/:id/actions/:actionId`：完整记录；未知 Session/Action 返回 404。
- `GET /artifacts/:artifactId`：仅允许当前 Action 索引引用的合法 UUID；路径、绝对路径、encoded traversal、未引用和未知 ID 一律不能读取文件。读取后校验 byteLength/SHA，损坏也返回 404。
- Artifact 响应：Cache-Control=no-store、X-Content-Type-Options=nosniff；DOM=text/plain; charset=utf-8，JPEG=image/jpeg，并设置限制性 CSP。
- 独立 action-update 经 WS 实时更新；重连时 REST 补回历史，新的 WS 更新优先，避免旧快照覆盖新状态。

Actions 在 Live Session 下，原始 Timeline 保留。摘要含 kind/actor/时间/耗时/目标/证据状态/请求和错误数；展开显示 Before/After、网络和页面事件。TYPE 只显示字符数。DOM 点击加载后使用普通 React `<pre>` 文本，没有 dangerouslySetInnerHTML。partial/failed 提示 Evidence incomplete。刷新与关闭之后仍能查看当前 Control 保存的记录。

## 测试结果

环境：Windows / PowerShell，Node.js 24.6.0，pnpm 10.17.1，Playwright 1.55.1，Chromium 140.0.7339.186，Vite 7.3.6。命令使用指定 pnpm 10 与本机 Chromium 执行权限，只访问本地 fixture。

| 命令 | 最终结果 |
| --- | --- |
| pnpm typecheck | PASS，根目录及六个 workspace 包 |
| pnpm test | PASS，44 tests、44 pass、0 fail、0 skipped、0 cancelled（含父测试计数） |
| pnpm build | PASS，49 modules，生产 Web 资源构建成功 |
| pnpm dev | PASS，独立端口服务启动并完成交互式验收 |

原有 M1.1–M1.3 共 32 项继续通过。测试辅助只增加 artifact 目录覆盖与新 Worker union 的类型处理，没有删除或跳过历史用例。

M1.4 新增 12 个计数项：真实 Runtime 测试组 8（父项+7 子项）、500 Action 后证据限额 1、API/UI 集成 1、ArtifactStore 原子性/路径/预算 1、metadata 环形上限与中断 1。覆盖包括：

- down/up 一个 click，三种按钮，drag 起止位置；10,000 move 的 Recorder 归并结果为 0，真实 WS 移动洪泛继续由 M1.3 覆盖。
- hello + 测试 合并一个 type/count=7；wheel burst 一个 scroll；modifier 无独立 Action，KeyA/Backspace/Enter 形成 key。
- BEFORE/AFTER DOM 和 JPEG SHA 不同；JPEG magic、byteLength、SHA 和输入遮盖像素正确；target 为真实 button/Remote Click Target。
- DOM 中 password/hidden/data-secret/script/template/comment/contenteditable 哨兵和输入原文不存在。
- 1500ms 慢响应参与 settle；3000ms 响应晚于 Action endSequence，仍可通过 requestId 关联；持续请求达到 2000ms 上限后完成。
- 注入失败 ArtifactStore，click 仍触发真实 DOM/console，Session 不关闭；低预算跳过证据；pointer-down 后关闭为 interrupted 并保留 Before。
- UI 实时更新、查看纯文本 DOM、刷新恢复、关闭后图片可读、390px 无水平溢出；应用日志和 metadata 没有输入原文。
- traversal、编码路径、未知/未引用文件、损坏文件返回 404；相同 store 重建实例也不能绕过磁盘预算，失败保留旧文件且无残留 tmp。

## 交互式人工验收

通过 Codex 浏览器 UI 工具操作本地 fixture，独立于自动化用例；不是用户亲自签署的 UAT。端口 Web=5175、Control=4330、Worker=4331，测试证据目录显式为 `test-results/m14-manual-artifacts`，没有加载 auth Cookie。Session `8d64a716-4dcb-4bd6-8ff0-7cb5881032c6` 已关闭，现有其他端口的登录 Session 未中断。

| 项目 | 观察结果 |
| --- | --- |
| 接管 + Remote Click Target | 实时出现 recording → completed CLICK，target=button Remote Click Target；Before/After 均可读，GET action=1 与 HTTP 200 可见 |
| 输入框 + hello测试 | TYPE 7 characters，Action 不显示原文；After DOM 仅 `[REDACTED]`，输入区域截图呈黑色遮盖 |
| slider | 一个 DRAG，18 → 83 → 92，Before/After 均完整 |
| Backspace / Tab / Enter | 3 个 KEY，Backspace 将长度减为 6，Tab 聚焦第二框，Enter 触发本地表单日志 |
| 滚动到底 | 一个 SCROLL，Δy=1923，出现 remote-scroll-ok |
| 刷新 | 同一 Session，VIEW ONLY，9 个 Actions 和 Timeline 恢复 |
| 关闭 | Live View 停止，9 个 Action 仍可展开，Before/After 与网络详情可查看 |

最终 9 个 Action（3 click / 1 type / 1 drag / 3 key / 1 scroll）全部 completed、evidenceStatus=complete。额外通过 API 检查全部 18 个 DOM 文件，输入原文和秘密哨兵命中为 0；Action JSON 也没有原文。目视确认纯文本 DOM、Before 的 BEFORE 状态及 After 输入遮盖。

开发服务中的首次 click settle 达到上限（总耗时约 2280ms），UI 明确显示“等待已达上限”；操作仍完成且证据完整。此行为符合 bounded settle 语义，不把 HTTP 响应头到达误当作全页面稳定。其他已验收 Action 约 398–877ms；不承诺第三方页面零额外延迟或原子截图。

## 限制与范围确认

- CAPTCHA：仍未解决，非本里程碑阻塞项，本次未尝试修复或验证外部 CAPTCHA。
- scoped auth 保留为本地诊断/bootstrap，不扩展认证系统，也不把 Cookie 写入 Evidence。
- 浏览器事件/截图可能含页面其他业务敏感信息；只做指定表单脱敏，不是通用 DLP。
- 无历史索引重启恢复、远端 ArtifactStore、多 Worker 分布式配额、自动垃圾回收、popup 控制、完整 shadow/iframe DOM、触摸或原生对话框。
- 未实现 AI/LLM/Agent、Finding/Diagnosis、Replay、Regression 产品能力、Jira、HAR/Video、请求/响应正文、Cookie/Storage snapshot、数据库或云对象存储。
- 完成后以本分支提交收尾，检查工作树干净；不自行进入 M2。
