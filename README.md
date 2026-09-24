# IMREPO — Image Registry Studio (DBX Plugin)

一站式容器镜像仓库管理插件（Image Registry Studio）。基于 OCI 标准，深度兼容 Harbor 及主流开源/闭源镜像仓库，在 DBX 工作台内提供统一的图形化浏览、多仓库切换、镜像 Tag 管理（修改/删除）、镜像层分析与安全漏洞报告查看体验。

> 对应 PRD：`dbx-plugin-imrepo.md`（见本仓库根目录）。本插件按 DBX 插件规范实现，源码目录为 `imrepo-dbx-plugin/`。

## 架构

```
┌───────────────────────────────────────────────┐
│  DBX Host                                       │
│  ┌──────────────┐      ┌────────────────────┐  │
│  │ 连接表单       │      │ 工作台 (沙箱 iframe) │  │
│  │ (manifest 声明) │      │  ui/  (HTML/CSS/JS)│  │
│  └──────┬───────┘      └─────────┬──────────┘  │
│         │   lifecycle RPC         │ invoke/notify │
│         ▼                        ▼              │
│  ┌───────────────────────────────────────────┐  │
│  │  Go Sidecar (backend/, stdio-jsonl v1)     │  │
│  │  OciClient · HarborClient · AuthProviders  │  │
│  └──────────────────┬────────────────────────┘  │
└─────────────────────┼───────────────────────────┘
                      ▼  HTTPS
             OCI Registry v2 / Harbor API v2.0
```

- **前端**：运行在沙箱 iframe，通过 `window.dbxPlugin.invoke()` 调用 Sidecar，不直接访问网络（规避 `host.network` 8 个 origin 上限）。
- **后端**：Go 原生 Sidecar，使用官方 SDK `github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk`，通过 `stdio-jsonl` 与宿主通信，代理所有仓库请求并处理认证。

## 功能（对照 PRD）

| 模块 | 说明 | 状态 |
|------|------|------|
| 连接与预设 | Harbor / Registry v2 / Docker Hub / GHCR / Aliyun ACR / Tencent TCR / AWS ECR / Azure ACR / Nexus / Artifactory / Quay 预设 | ✅ |
| 多元认证 | Basic/密码、Harbor Robot、Bearer/PAT、云厂商 AK/SK（AWS SigV4、Aliyun HMAC-SHA1、Tencent TC3） | ✅ |
| 仓库浏览 | Harbor 项目树 / 通用 `_catalog` 列表，模糊搜索，列表/卡片双视图 | ✅ |
| 项目镜像总览 | 点击项目「文件夹」即列出**项目下所有镜像**（跨仓库聚合）：顶部统计镜像数/总大小/仓库数/Tag 数，列表按推送时间降序、每行一个 digest（**不含 Tag 列**），带 pull/镜像层/漏洞操作 | ✅ |
| Tag 管理 | Tag 列表、**重命名 Tag**（写新 Tag + 删原 Tag）、删除（OCI DELETE / Harbor 原生） | ✅ |
| 镜像层解析 | Manifest → Index → Config Blob 逐层 Dockerfile 指令；**每层大小**（加粗数值 + 占比条 + 百分比 + 最大层高亮 + 按大小排序） | ✅ |
| 漏洞报告 | Harbor additions/vulnerabilities（Trivy CVE 分级统计 + **按设置阈值判定**「已达/未达阈值」+ 缓存 + 刷新/触发扫描） | ✅ |
| 快捷工具 | **拉取命令弹窗**：逐条列出 镜像地址 / docker / nerdctl / crictl / podman / ctr / docker login，点任意一行即复制该条（不再把多条拼一坨塞进剪贴板） | ✅ |
| 加载体验 | 展开项目后台**预热**前 6 个仓库（串行、不打扰仓库）；列表带 60s 缓存与请求去重；点击行/内容区都有转圈；**慢响应不会覆盖后点的仓库** | ✅ |
| 运维清理（PRD 2.4） | **清理无 Tag 孤立 Artifact**：扫描项目 → 列出可回收清单（含大小/推送时间/合计）→ 勾选确认 → 逐个删除并回报结果；**受清理规则保护的条目不可勾选并给出原因** | ✅ |
| 设置（刷新按钮旁） | 条件清理 / 保留策略 / 镜像扫描器 / **用户管理** / 关于 IMREPO；按连接持久化，**由后端强制执行**而不只是记住数字 | ✅ |
| 项目设置（文件夹上的齿轮） | 每个项目行的齿轮打开**项目设置**：成员与角色（添加/改角色/移除）+ **回收策略**（Harbor tag retention，先读已有再写回） | ✅ |
| 用户管理 | Harbor 用户列表 / 创建用户 / 重置密码 / 授予或收回管理员 / 删除用户 | ✅ |
| 连接表单 | 显式 **HTTP / HTTPS 协议选择** + **No Authentication**（无需任何认证字段） | ✅ |
| Harbor 自动识别 | 连接类型选成 Docker Registry v2 但服务器实际是 Harbor（最常见的误配）时，`/api/v2.0/ping` 探测成功即**自动启用 Harbor 功能**，连接消息中注明；真正的非 Harbor 注册表仍明确拒绝 | ✅ |
| 性能 | 项目镜像总览与清理扫描**并发拉取**各仓库的 Artifact（限 6 并发），多仓库项目从串行等待变成一小段等待 | ✅ |

## 目录结构

```
imrepo-dbx-plugin/
├── manifest.json                 # 插件清单：connection-provider + workbench + backend
├── dbx-plugin.toml               # 构建配置（[backend] Go + [package].include）
├── assets/                       # 插件级图标（plugin.svg / connection.svg）
├── ui/                           # 工作台 UI（沙箱 iframe）
│   ├── index.html
│   ├── styles.css                # 明/暗主题调色板（私有 --im-* 令牌，见下文）
│   ├── app.js                    # 工作台逻辑 + 内联 SVG 图标（ICONS）
│   └── assets/plugin.svg
├── tools/check-contrast.py       # 配色对比度门禁（WCAG，CI 可跑）
├── tools/make-preview.py         # 由 ui/index.html + .preview/mock.js 生成验证台
├── .preview/mock.js              # 验证台的 mock 桥 + 宿主令牌注入（唯一真源）
├── .preview/preview.html         # 生成物，勿手改（不入包）
├── backend/                      # Go Sidecar 源码
│   ├── main.go                   # SDK Server + RPC 分发
│   ├── types.go                  # Connection 解析与配置读取
│   ├── session.go                # 会话管理（按 connection.id 缓存凭证）
│   ├── auth.go                   # Basic / Robot / Bearer 认证
│   ├── cloud.go                  # AWS ECR / Aliyun ACR / Tencent TCR 换 Token
│   ├── oci.go                    # OCI Registry v2 客户端（含 token-challenge 流程）
│   └── harbor.go                 # Harbor REST API v2.0 客户端
├── .github/workflows/plugin-release.yml
└── README.md
```

## 构建与打包

依赖：Node.js 22+、Go 1.22+。

```bash
# 安装 CLI
npm install -g @dbx-app/plugin-cli

# 打包（会编译 Go 后端，生成未签名候选包）
cd imrepo-dbx-plugin
dbx-plugin package .
# → dist/com.dbx.plugin.imrepo-1.2.0-windows-x64.dbxp
# → dist/com.dbx.plugin.imrepo-1.2.0-windows-x64.artifact.json
```

本地调试：

```bash
dbx-plugin dev --path . --port 5190
# 打开 http://127.0.0.1:5190/
```

### 版本号：只需改一个地方

宿主会校验后端自报身份与清单是否一致，不一致直接拒绝初始化：

```
Plugin backend identity 'com.dbx.plugin.imrepo/1.2.0' does not match manifest 'com.dbx.plugin.imrepo/1.2.1'
```

为了让"发版忘了同步两处版本号"这类问题不可能再发生，Sidecar **不再硬编码版本**：启动时从自身所在位置向上查找 `manifest.json`（安装后位于 `<plugin>/bin/<target>/`，即向上 3 级；`dbx-plugin dev` 下同样能找到项目清单），用清单里的 `id`/`version` 作为自报身份，找不到才回退到编译期常量并在 stderr 打一行诊断。

因此**升版本只改 `manifest.json` 的 `version`**（同时建议把 `backend/main.go` 的 `pluginVersion` 常量作为兜底一起更新）。

```bash
# 验证身份是否与清单一致（无需真机安装）
printf '{"jsonrpc":"2.0","id":1,"method":"plugin/initialize","params":{"host":{"protocolVersions":[1]}}}\n' \
  | ./bin/windows-x64/imrepo-sidecar.exe
# → {"plugin":{"id":"com.dbx.plugin.imrepo","version":"1.2.1"}, ...}
```

## 测试

```bash
# 五个端到端回归
python tools/test-retag-e2e.py      # 重命名 Tag：跑真实 Sidecar，断言实际发出的 HTTP 请求序列
python tools/test-layers-e2e.py     # 镜像层解析：跑真实 Sidecar，断言逐层大小/指令/总量
python tools/test-cleanup-e2e.py    # 孤立 Artifact 清理：扫描/删除行为 + 复核安全规则
python tools/test-settings-e2e.py   # 设置：默认值/持久化/校验/规则生效/Tag 保护/扫描器与缓存
python tools/test-ui-e2e.py         # 界面行为：无头浏览器渲染真实 UI，断言 DOM

# 配色对比度门禁
python tools/check-contrast.py
```

- `test-retag-e2e.py` 覆盖 5 组场景（Harbor 真重命名 / 通用 v2 保留原 Tag 并给出 warning / 仅拷贝 / 非法 Tag / 相同 Tag）。它验证的是**请求序列**而不只是返回值，因为"重命名"这个功能的价值恰恰在那三步 HTTP 调用上。
每个测试都会在结束时报出**它实际执行了多少条断言**（`RESULT: ALL PASS (N checks)`），所以下面的数字可以直接跑一遍核对，不必相信文档：

| 测试 | 断言数 | 验证的是 |
|---|---|---|
| `test-settings-e2e.py` | 72 | 设置的持久化、校验与**实际生效**（后端行为） |
| `test-ui-e2e.py` | 48 | 界面行为与策略可见性（浏览器渲染真实 UI） |
| `test-layers-e2e.py` | 23 | 逐层大小/指令/总量解析 |
| `test-cleanup-e2e.py` | 21 | 孤立 Artifact 清理的安全规则 |
| `test-retag-e2e.py` | 17 | 重命名 Tag 的真实请求序列 |
| `check-contrast.py` | 全量配色对 | 配色对比度门禁 |

- `test-layers-e2e.py` 覆盖 7 组场景，重点是 **BuildKit attestation**：如果 Manifest List 里 `platform: unknown/unknown` 的 attestation 条目排在前面而被选中，拿到的"镜像"层列表是无意义的 —— 表现出来就像"逐层大小功能没做出来"。测试断言此时仍必须解析出真正的镜像（B/C 两组）。
- `test-cleanup-e2e.py` 覆盖扫描准确性（只列出无 Tag 的 IMAGE/CHART，带 Tag 的不列）、删除与回收量、**复核安全规则**（扫描后被重新打标的 Artifact 必须跳过且不发 DELETE）、目标消失时的处理、批量上限、以及非 Harbor 仓库的明确报错。
- `test-ui-e2e.py` 用无头浏览器渲染真实 UI 并断言 DOM，覆盖：**竞态**（点慢仓库 A 后立刻点快仓库 B，最终必须显示 B）、**加载反馈**（内容区与所点行都有转圈）、**预热与缓存**（后台果然请求了若干仓库；点击已预热的仓库只发一次请求）、**清理弹窗**（列出扫描结果、报告扫描统计、未选中时销毁性按钮必须禁用）、**设置面板**（四段齐全、脏值提示、「应用到 Harbor」两步门禁、受保护条目与阈值判定在界面上可见）。竞态那组会在测试内临时摘掉守卫自检灵敏度 —— 摘掉后必须失败。
- `test-settings-e2e.py` 覆盖 9 组场景，重点是**设置真的改变了行为**：默认值 → 保存 → **重启进程后仍在**（证明落盘持久化）→ 按连接隔离 → 校验拒绝非法值且不写入 → 清理规则在扫描与删除两条路径上生效（**受保护的条目不计入删除且不发 DELETE**）→ 受保护 Tag 的删除/改名被拒（**且没有半写状态：不发 PUT**）→ 阈值/缓存/关闭开关 → Harbor 侧扫描器的读取与「只写差异、保留其他键」的写回 → 非 Harbor 仓库的明确报错。测试把 `APPDATA` 重定向到临时目录，从不碰用户真实配置。

### 清理无 Tag Artifact 的安全设计

破坏性操作，按「只读扫描 → 风险提示 → 明确确认 → 逐条复核」实现：

| 环节 | 做法 |
|---|---|
| 扫描 | 遍历项目内仓库（上限 100 个，超出会明示 `truncated`）；只收 **tags 为空或缺失** 的 artifact；只收 IMAGE / CHART，其他类型（CNAB/WASM/UNKNOWN）不动 |
| 失败不吞 | 某个仓库读不出来 → 记入 `repositoryErrors` 并在界面标黄，不静默当成"干净" |
| 确认 | 弹窗列出每条的大小/推送时间与可回收合计，默认全选但必须显式点「清理选中 (N)」；未选中则按钮禁用 |
| **删除前复核** | 每个目标先重新 GET 一次，确认**此刻仍然无 Tag** 才删除。扫描到确认之间可能已有人给它打了 Tag，那它就不能删 —— 这类目标计入 `skipped` 而不是被删掉 |
| 上限 | 单次调用超过 300 条直接拒绝，避免客户端 bug 变成批量误删 |

跳过/失败/成功三份明细都会回传到界面提示里，不会只报一句"成功"。

### 设置（工具栏「设置」按钮）

设置**存储在侧车进程**，文件位于用户配置目录 `imrepo-dbx-plugin/settings.json`，按 `connectionId` 分键（同一台机器上两个仓库连接可以有不同策略）。放进后端有两个原因：沙箱 iframe 没有可靠的持久存储，而且**策略必须由后端执行** —— 只被界面记住的规则只是一个约定。

| 分组 | 字段 | 它真正改变什么 |
|---|---|---|
| 条件清理 | 每个仓库保留最近 N 个无 Tag 产物 | 这些条目在「清理无 Tag」里被标记为受保护，不可勾选 |
| | 只清理早于 N 天的产物 | 同上；**推送时间读不出来的条目按最新处理（保守保留）** |
| | 永不清理的仓库 | glob（如 `libs/*`、`internal-*`），命中仓库的全部条目受保护 |
| | 单次扫描仓库上限 | 替换默认的 100，防止大项目变成无边界扫描 |
| 保留策略 | 每个仓库保留最近 N 个产物 | **仅界面提示**：超出窗口的产物打上「超出保留策略」标记，不会自动删除 |
| | 受保护的 Tag | glob（如 `latest`、`release-*`）；**后端强制**：删除被拒，重命名连带删源 Tag 也被拒（只新增 Tag 仍允许） |
| 镜像扫描器 | 数据源 / 等级阈值 / 缓存秒数 | 阈值决定面板的「已达阈值」判定与哪些等级需要关注；缓存秒数决定报告复用时长（0 = 每次重取） |
| | 推送时自动扫描 / 阻止拉取高危镜像 / 项目扫描器 | **写入 Harbor**（项目 metadata 与项目 scanner），采用「读取 → 合并 → 写回」，不会覆盖本插件不认识的键 |
| 关于 IMREPO | 版本 / 插件 ID / 后端协议 / GitHub / 设置文件路径 | 版本来自打包清单（不硬编码）；GitHub 暂为空 → 界面显示「待补充」而不是死链 |

破坏性动作有两道门：**「应用到 Harbor」是两步点击**（第一次只显示"将要写入什么"，并只提交与当前 Harbor 状态不同的键），**「恢复默认」也是两步**。

规则在**两条路径**上都生效：扫描时标记候选，**删除前再用实时列表重算一次** —— 扫描到确认之间改了规则或仓库变了，都不会漏过去。

### 加载与缓存策略

大仓库列表要几秒，所以做了四件事，都在 `ui/app.js`：

| 机制 | 作用 |
|---|---|
| `state.cache` + `CACHE_TTL_MS`(60s) | 列表按仓库缓存；`invalidate()` 在刷新/改名/删除后精确失效 |
| `state.inflight` | 同一仓库的并发请求合并为一个（点击撞上预热时不会重复请求） |
| `state.viewSeq` | **只允许最新一次选择绘制视图**：慢响应晚到会被丢弃，不会把 A 的镜像画到 B 名下 |
| `schedulePrefetch` | 展开项目后串行预热前 6 个仓库 —— 只为一个目的：让点击变即时，所以刻意不发并发风暴 |

`state.loadingKeys` 驱动侧栏行上的小转圈，因此"正在加载"的反馈出现在你点的那一行，而不只是内容区。

### 镜像层解析的取舍

- 层大小来自 Manifest 的 `layers[].size`，即**压缩后大小**（与 `docker images` 的体积口径一致）；不做解压，避免为看一个数字而拉取数百 MB。
- 逐层 Dockerfile 指令来自 Config Blob 的 `history`，跳过 `empty_layer: true` 的条目后按顺序与 `layers[]` 对齐。
- Manifest List 按"linux/amd64 → 其他已知平台 → 未知平台"排序逐个尝试，任一条目取回后若不含 `layers`/`config` 则继续试下一条；全部失败才报错（不返回空列表）。

## UI 主题与配色（重要约定）

**不要使用 `--color-*` / `--radius*` / `--font*` 作为自定义变量名。**

DBX 宿主的 `PluginWorkbenchHost.vue → currentBridgeTheme()` 会遍历宿主自身的所有自定义属性，凡匹配 `/^--(color|radius|font)/` 的都会**以行内样式注入插件沙箱**，同时写入 `data-dbx-theme="dark|light"`。DBX 基于 Tailwind v4，其设计令牌本身就命名为 `--color-*`，因此：

- 行内样式优先级高于任何样式表 → 同名变量会被静默替换；
- Tailwind 的 `--color-muted` 是**弱化背景色**（浅色主题 `#f5f5f5`），不是弱化文字色。曾用它作 `color:`，导致表头、面包屑等次要文字在白底上近乎不可见（对比度 1.0）。

因此本插件的调色板全部落在私有命名空间 `--im-*`，只由 `data-dbx-theme` 驱动，完全不受宿主注入影响。字色分三级，均有明确对比度下限：

| 令牌 | 用途 | 浅色 | 深色 |
|------|------|------|------|
| `--im-fg` | 正文 | `#1b1d21` (16.9:1) | `#e7e9ee` (15.6:1) |
| `--im-fg-muted` | 次要文字（表头/面包屑） | `#5a616b` (6.3:1) | `#a2a9b5` (8.0:1) |
| `--im-fg-subtle` | 11px 元信息/占位符 | `#616875` (5.0:1) | `#8c94a2` (5.6:1) |

配套约束：

- 文字用 `--im-fg*`，填充按钮用 `--im-primary-solid` / `--im-danger-solid`（配 `--im-primary-fg` / `#fff`）；纯文字/图标用 `--im-primary`。深色主题下两者取值不同（浅蓝文字 vs 深蓝底），否则白字按钮或蓝字必然有一方不达标。
- 图标一律用内联 SVG（`app.js` 的 `ICONS` + `svgIcon()`）继承 `currentColor`；`◫ / 🛡 / ✕` 这类字形在 13px 下呈细轮廓，观感发虚。
- 作者样式里任何 `display:flex/grid` 都会覆盖 HTML `hidden` 的 UA 默认值，故 `styles.css` 顶部固定有 `[hidden] { display: none !important; }`。

改动配色后必须过门禁（失败返回非 0）：

```bash
python tools/check-contrast.py            # WCAG AA 全量校验 + 宿主令牌命名冲突检测
python tools/check-contrast.py --verbose  # 打印每一对
```

渲染侧验证（Windows 自带 Edge 即可，无需装浏览器）：

```bash
# 改了 ui/index.html 或 .preview/mock.js 之后必须重新生成（否则验证台用的是旧 DOM，
# 会让你误判"功能没生效" —— 这个坑踩过一次）
python tools/make-preview.py

# preview.html 会故意注入宿主那套 Tailwind 令牌，并 mock invoke() 数据
msedge --headless=new --window-size=1360,880 --virtual-time-budget=5000 \
  --screenshot=shot.png "file:///.../.preview/preview.html?theme=light&modal=retag"
# 可用参数：
#   theme=light|dark        mode=harbor|docker      view=cards
#   modal=retag|layers|vuln|delete|pull|cleanup|settings
#   ---- 设置与策略相关（用来把界面驱动到"设置已生效"的状态）----
#   keeptagged=N protect=latest,release-*   # 保留窗口外的产物标记 / 受保护 Tag（锁图标）
#   keepuntagged=N minage=N excluderepos=a,b  threshold=critical|high|medium|low
#   rules=1        # 清理弹窗的条目带受保护标记与原因
#   dirty=1        # 改一个字段，展示脏值提示
#   armapply=1     # 打开设置并把「应用到 Harbor」点到确认态
#   scroll=bottom  # 设置弹窗滚到底（截图扫描器/关于段）
# 每次务必换一个 --user-data-dir，否则 Edge 静默失败、不产出文件
```

`.preview/preview.html` 由 `tools/make-preview.py` 从真实的 `ui/index.html` 生成（只插入 `<base>` 与 mock 脚本），因此**不存在"验证台 DOM 与真实 UI 脱节"的风险**；要加控件只改 `ui/*`，不要手改生成物。

## 后端 RPC 方法

| 方法 | 参数 | 说明 |
|------|------|------|
| `app/info` | — | 关于面板：`{pluginId, version, protocolVersion, transport, settingsPath, github}` |
| `settings/get` | `connectionId?` | 读取该连接的设置 + `isDefault` + 文件路径 |
| `settings/set` | `connectionId?`, `settings` | 校验后保存（非法值一律拒绝，不静默改成默认值） |
| `settings/reset` | `connectionId?` | 删除该连接的配置，回到默认值 |
| `registry/info` | — | 返回 `{registryType, endpoint, name}` |
| `registry/catalog` | `search?` | 仓库列表（`GET /v2/_catalog`） |
| `registry/tags` | `repository` | Tag 列表 |
| `registry/manifest` | `repository`, `reference` | 获取 Manifest（body + digest + mediaType） |
| `registry/layers` | `repository`, `reference` | 逐层解析（含 Dockerfile 指令与体积） |
| `registry/retag` | `repository`, `sourceTag`, `targetTag`, `deleteSource?` | 重命名 Tag：先 PUT 新 Tag，`deleteSource` 为真时再删原 Tag |
| `registry/delete` | `repository`, `digest` | 按 digest 删除 |
| `harbor/projects` | — | Harbor 项目列表 |
| `harbor/repositories` | `project` | 项目下仓库列表 |
| `harbor/artifacts` | `project`, `repository` | Artifact（含 tags）列表 |
| `harbor/images` | `project` | 项目级镜像总览：全部镜像 + 镜像数/总大小/仓库数/Tag 数，按推送时间降序（读取失败的仓库以 `repositoryErrors` 回报） |
| `harbor/deleteTag` | `project`, `repository`, `reference`, `tag` | Harbor 原生删 Tag |
| `harbor/deleteArtifact` | `project`, `repository`, `reference` | Harbor 删 Artifact |
| `harbor/untagged` | `project` | 扫描项目内无 Tag 的孤立 Artifact（清单 + 可回收合计 + 扫描统计 + **应用了哪些清理规则** + 受保护条目与原因） |
| `harbor/cleanupUntagged` | `project`, `targets[{repository,reference,size}]` | 逐个**复核后**删除（见下文安全设计），返回 删除/跳过/失败 三份明细 |
| `harbor/vulnerabilities` | `project`, `repository`, `reference`, `force?` | CVE 报告 + 阈值判定（缓存的是 Harbor 的原始发现，**判定按当前阈值实时计算**） |
| `harbor/scannerInfo` | `project?` | Harbor 侧实况：可用扫描器、项目扫描器、项目 metadata（读不到的部分以 `notes` 回报，不整体失败） |
| `harbor/applyScanner` | `project`, `scannerUuid?`, `autoScan?`, `preventVul?`, `severity?` | **写入 Harbor**（只提交给定的键；metadata 走读取-合写-回写） |
| `harbor/scan` | `project`, `repository`, `reference` | 触发一次扫描（异步），并清掉该连接的漏洞缓存 |
| `harbor/projectAdmin` | `project` | 项目管理聚合读：项目详情（含 retentionId）+ 成员 + 保留策略 + 用户列表；任一部分失败以独立错误字段回报 |
| `harbor/memberAdd` / `memberRole` / `memberRemove` | `project`, `roleId`/`memberId` | 项目成员的添加 / 改角色 / 移除 |
| `harbor/retentionSave` | `project`, `projectId`, `policy` | 保存保留策略：已有策略 PUT 整体写回，没有则 POST 创建（绑定 scope） |
| `harbor/users` / `userCreate` / `userPassword` / `userDelete` / `userAdmin` | 见代码 | Harbor 用户管理（需要管理员权限） |

### 重命名 Tag 的语义

OCI Distribution **没有 rename 原语**，也不能按 digest 删除单个 Tag（那会把指向同一 Manifest 的所有 Tag 一起删掉，包括刚写的新 Tag）。因此重命名只能是：

1. `GET /v2/<repo>/manifests/<原 Tag>` 读出 Manifest；
2. `PUT /v2/<repo>/manifests/<新 Tag>` 以原内容写回 —— 不重传任何镜像层；
3. 删除原 Tag。**只有 Harbor 提供按 Tag 删除的接口**（`DELETE /api/v2.0/projects/{p}/repositories/{r}/artifacts/{ref}/tags/{tag}`），其他仓库做不到。

所以 UI 里的「同时删除原 Tag（完成重命名）」勾选项在 Harbor 上默认勾选；通用 OCI v2 下该项被禁用并给出提示，后端也会在返回值里带 `warning` 说明"原 Tag 已保留、需手动删除"，而不是假装成功：

```json
{"ok": true, "sourceTag": "1.25", "targetTag": "1.25-pinned", "sourceRemoved": false,
 "warning": "new tag \"1.25-pinned\" created, but the old tag \"1.25\" was kept: ..."}
```

新 Tag 与仓库路径都在后端做 `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}` / 非空校验，UI 同步做一遍即时反馈。

认证方式 → 后端映射（`auth_type`）：

| auth_type | 字段 | 协议 |
|-----------|------|------|
| `basic` | username + password | `Basic base64(user:pass)` |
| `robot` | username + password | `Basic base64(robot$name:secret)` |
| `token` | token | `Bearer <token>` |
| `aws-ecr` | access_key_id + secret_access_key + region | SigV4 → `ecr:GetAuthorizationToken` |
| `aliyun-aksk` | access_key_id + secret_access_key + region(+instance_id) | HMAC-SHA1 → `GetAuthorizationToken` |
| `tencent-aksk` | secret_id + secret_key + region + instance_id | TC3 → `DescribeInstanceToken` |

## 安全说明

- 凭证仅在 `connection/test`、`connection/connect` 等生命周期请求中由宿主传入，Sidecar 按 `connection.id` 缓存会话，UI 不接触任何密钥。
- 云厂商 AK/SK 仅用于换取临时凭证，不落盘、不写入日志（stderr 仅输出诊断）。
- 删除为软删除（解除 Tag 与 Manifest 绑定），空间回收需仓库侧执行 GC，UI 已做二次确认与提示。

## 里程碑

- Phase 1（预设 + 多模式认证）✅
- Phase 2（Tag 管理：修改/删除）✅
- Phase 3（Harbor 深度适配：项目树 + 漏洞面板）✅
- Phase 4（打包发布）✅ 已生成 `.dbxp` 候选包；上架 `dbx-store` 走发布工作流 + 官方签名。

PRD 功能项状态：2.1 连接与预设 ✅ / 2.2 项目与镜像浏览 ✅ / 2.3 Tag 管理与 Manifest 解析 ✅（含重命名）/ **2.4 DevOps 快捷工具与运维 ✅**（命令生成器 + 无 Tag 清理）。
