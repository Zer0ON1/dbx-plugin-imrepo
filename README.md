# IMREPO — Image Registry Studio

> 一个 DBX 插件：在一个工作台里浏览、管理和检查 OCI / Harbor 容器镜像仓库。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-windows%20%7C%20linux%20%7C%20macos%20(x64%2Farm64)-informational)](#安装)
[![Plugin API](https://img.shields.io/badge/DBX%20Host%20API-1-informational)](https://dbxio.com/cn/docs/plugin-development)

一站式容器镜像仓库管理插件（Image Registry Studio）。基于 OCI 标准，深度兼容 Harbor 及主流开源/闭源镜像仓库，在 DBX 工作台内提供统一的图形化浏览、多仓库切换、镜像 Tag 管理（修改/删除）、镜像层分析与安全漏洞报告查看体验。

> 对应 PRD：`dbx-plugin-imrepo.md`（见本仓库根目录）。

## 安装

1. 从 [Releases](https://github.com/Zer0ON1/dbx-plugin-imrepo/releases) 下载与你的平台匹配的 `.dbxp`：
   `windows-x64` / `windows-arm64` / `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`。
2. 在 DBX 插件中心显式开启**「允许安装未签名开发包」**（当前发布的是未签名候选包，见[发布](#发布)）。
3. 安装后新建连接，选择仓库类型（Harbor / Docker Registry v2 / 云厂商托管 …），填写地址与认证方式。

Sidecar 是**静态链接**的 Go 二进制（`CGO_ENABLED=0`），不依赖目标机的 libc，因此在老发行版上也能跑 —— 已在麒麟 V10（aarch64 / glibc 2.28 / 内核 4.19）上实测通过。

## 截图

| | |
|---|---|
| ![Harbor 项目树与 Tag 列表](docs/screenshots/harbor-artifacts.png) | ![Docker Registry v2 命名空间](docs/screenshots/v2-namespaces.png) |
| Harbor 项目树、Tag 列表与**架构徽章**（一个架构一个圆圈） | Docker Registry v2 命名空间树（V2 没有项目对象，按仓库名首段归类） |
| ![总览图表](docs/screenshots/overview-harbor.png) | ![镜像层解析](docs/screenshots/layers.png) |
| 总览页签：拉取最多的项目 + 项目存储分布 | 逐层解析：Dockerfile 指令、每层大小与占比 |
| ![无 Tag 清理](docs/screenshots/cleanup.png) | ![漏洞报告](docs/screenshots/vulnerabilities.png) |
| 无 Tag 孤立产物清理（受规则保护的条目不可勾选） | CVE 报告与阈值判定 |

| | |
|---|---|
| ![深色主题](docs/screenshots/dark.png) | ![项目设置](docs/screenshots/project-settings.png) |
| 深色主题（配色由 `--im-*` 私有令牌驱动，跟随宿主主题） | 项目设置：可见性、配额、成员、保留策略、本项目扫描器 |

截图由 `python3 tools/shoot-screenshots.py` 从真实 UI 生成，可随代码重新生成。

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
| 仓库浏览 | Harbor 项目树 / 通用 `_catalog` 列表，模糊搜索 | ✅ |
| **V2 项目管理** | Docker Registry v2 没有项目对象，故按仓库名**首段**分组为命名空间（无斜杠的扁平仓库自成项目）：命名空间树 + 该命名空间的仓库表与统计（镜像数/总大小/仓库数/Tag 数） | ✅ |
| 项目镜像总览 | 点击项目「文件夹」即列出**项目下所有镜像**（跨仓库聚合）：顶部统计镜像数/总大小/仓库数/Tag 数，列表按推送时间降序、每行一个 digest（**不含 Tag 列**），带 pull/镜像层/漏洞操作 | ✅ |
| **总览页签与图表** | 侧栏「总览」tab：统计卡（项目/仓库/镜像/总空间）+ SVG 横向柱状图（Harbor：拉取最多的项目、项目存储分布；V2：命名空间存储分布）+ 最近新建/拉取最多项目的链接列表 | ✅ |
| **架构结构展示** | 多架构镜像按平台逐个展示为**一个圆圈徽章**（`linux/amd64`、`linux/arm64`…）：Harbor 从 artifact 的 `references[].platform` 解析；V2 的 Tag 列表不带平台信息，故懒加载 `registry/arches` 回填并缓存 | ✅ |
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
dbx-plugin-imrepo/
├── manifest.json                 # 插件清单：connection-provider + workbench + backend
├── dbx-plugin.toml               # 构建配置（[backend] Go + [package].include）
├── package.json                  # 开发依赖（插件 CLI 自带 Go SDK）与 npm scripts
├── assets/                       # 插件级图标（plugin.svg / connection.svg）
├── ui/                           # 工作台 UI（沙箱 iframe，classic script + window.IMREPO）
│   ├── index.html                # 按依赖顺序加载 js/*（不用 ES module，见下）
│   ├── styles.css                # 明/暗主题调色板（私有 --im-* 令牌）
│   ├── js/
│   │   ├── state.js              # 全部共享状态（含缓存/竞态守卫的 seq）
│   │   ├── i18n.js               # 中英文字典 + t()/applyI18n()
│   │   ├── dom.js                # el/$/图标/loading/toast/剪贴板
│   │   ├── format.js             # 体积/时间/digest/glob 等格式化
│   │   ├── rpc.js                # invoke 封装 + 缓存/去重/预热/竞态守卫
│   │   ├── settings-model.js     # 设置的默认值/草稿/校验（前端侧）
│   │   ├── render-sidebar.js     # 侧栏项目树与总览 tab
│   │   ├── render-content.js     # 内容区：镜像/Tag 表、项目总览、面包屑
│   │   ├── render-modals.js      # 拉取命令 / 重命名 / 删除
│   │   ├── render-layers.js      # 镜像层弹窗
│   │   ├── render-vuln.js        # CVE 弹窗
│   │   ├── render-cleanup.js     # 无 Tag 清理弹窗
│   │   ├── render-settings.js    # 全局设置弹窗（含关于）
│   │   ├── render-project.js     # 项目设置弹窗（成员/配额/扫描/可见性）
│   │   ├── render-users.js       # 用户管理
│   │   ├── render-overview.js    # 总览页签与 SVG 柱状图
│   │   ├── render-logs.js        # 操作日志
│   │   ├── render-create-project.js
│   │   └── main.js               # init/bootstrap/setupUI（事件绑定）
│   └── assets/plugin.svg
├── backend/                      # Go Sidecar 源码
│   ├── main.go                   # SDK Server 入口 + 身份解析（从 manifest 读 id/version）
│   ├── dispatch.go               # RPC 方法表 + 统一守卫（会话解析、Harbor 门禁）
│   ├── connection.go             # 连接生命周期：解析宿主 payload、校验、会话
│   ├── session.go                # 会话注册表（按 connection.id）
│   ├── types.go                  # Connection 解析与配置取值
│   ├── auth.go / cloud.go        # Basic/Robot/Bearer + AWS/Aliyun/Tencent 换 Token
│   ├── oci.go                    # OCI Registry v2 客户端（含 token-challenge）
│   ├── v2projects.go             # V2 命名空间视图（"项目"= 仓库名首段）
│   ├── harbor.go                 # Harbor REST v2.0 客户端
│   ├── registry.go / admin.go    # 项目生命周期（创建/配额/日志/总览）与管理面板聚合
│   ├── cleanup.go                # 无 Tag 清理（扫描 + 复核后删除）
│   ├── retag.go                  # 重命名 Tag（PUT 新 + 删旧）
│   ├── layers.go                 # Manifest → 逐层解析
│   ├── scanner.go / settings.go  # CVE 报告与扫描器；设置持久化与策略引擎
│   ├── pool.go                   # 有界并发的通用助手
│   └── credentials.go            # 每连接记住最后一次密码（宿主偶不下发 secret 时的兜底）
├── tools/                        # 开发脚本（Python，无第三方依赖）
│   ├── _harness.py               # 测试公共件：按平台选包/隔离配置/找浏览器/断言计数
│   ├── build-packages.py         # 六平台打包（含 manifest 逐目标改写）
│   ├── make-preview.py           # 由 ui/index.html + .preview/mock.js 生成验证台
│   ├── shoot-screenshots.py      # 生成 docs/screenshots/ 的 README 截图
│   ├── check-contrast.py         # 配色对比度门禁（WCAG AA + 令牌命名冲突）
│   └── test-{settings,layers,cleanup,retag,ui}-e2e.py
├── .preview/mock.js              # 验证台的 mock 桥 + 宿主令牌注入（**源文件，要提交**）
├── .preview/preview.html         # 生成物，勿手改（不入包、不提交）
├── docs/screenshots/             # README 用截图（由脚本生成）
├── .github/workflows/plugin-release.yml
├── CHANGELOG.md
└── README.md
```

### 为什么前端不用 ES module

工作台也通过 `file://` 打开（验证台与 UI 测试都这么加载）。Chromium 对 `file://` 下的 `type="module"` 脚本按 CORS（origin 为 null）**直接拒绝加载**——用了模块，整套 UI 测试与截图流程会静默失效。因此拆成多个 **classic script**，每个文件挂到共享的 `window.IMREPO` 命名空间上，跨模块调用一律 `IM.xxx`；所有可变的共享状态（`state`、`archCache`、`locale`、`pendingDelete` 等）也挂在命名空间上，否则每个模块会各持一份副本。

`index.html` 里 `<script>` 的顺序即依赖顺序（state → i18n → dom/format → rpc → settings-model → 各 render-* → main），**`main.js` 必须最后**（它调用 `init()`）。

## 构建与打包

依赖：Node.js 22+、Go 1.22+、Python 3（仅测试与打包脚本用）。

```bash
# 安装依赖：CLI 自带与本版本匹配的 Go SDK，Sidecar 就是对着它编译的
npm install

# 打包六个平台（windows / linux / darwin × x64 / arm64）
npm run package          # = python3 tools/build-packages.py
# → dist/com.dbx.plugin.imrepo-<版本>-<target>.dbxp     × 6
# → dist/com.dbx.plugin.imrepo-<版本>-<target>.artifact.json
# → dist/release-candidates.json                        （dbx-store 自动更新读它）
```

**一条命令出全部平台**，因为 `CGO_ENABLED=0` 让 Sidecar 静态链接，与构建机的 libc 无关 —— 于是老系统的 glibc 也不成问题（在麒麟 V10 / glibc 2.28 / aarch64 上实测通过）。官方 CLI `dbx-plugin package .` 只出**当前平台**的包（它拒绝交叉编译），所以多平台由 `tools/build-packages.py` 负责：它按目标平台**改写 manifest 的 `entrypoints.backend.executable`**（`bin/imrepo-sidecar` → `bin/<target>/imrepo-sidecar[.exe]`）、对**实际写入的字节**做 sha256、给二进制打 0755。

> 这条改写不是可选项：漏掉它，包能装、但宿主按 manifest 找不到可执行文件。而 Sidecar 的端到端测试是自己解包、自己执行二进制的，**测不出来**。所以测试里有一条专门的布局断言（见下），并且可以拿官方 CLI 的产物对比验收——两者的 `manifest.json` 应当逐字节一致。

本地调试（不启动 DBX 桌面端）：

```bash
npx dbx-plugin dev --path . --port 5190
# 打开 http://127.0.0.1:5190/
# 调试数据在 .dbx-dev/（已 gitignore，可能含明文凭据）
```

### 版本号：只需改一个地方

宿主会校验后端自报身份与清单是否一致，不一致直接拒绝初始化：

```
Plugin backend identity 'com.dbx.plugin.imrepo/1.2.0' does not match manifest 'com.dbx.plugin.imrepo/1.2.1'
```

为了让"发版忘了同步两处版本号"这类问题不可能再发生，Sidecar **不再硬编码版本**：启动时从自身所在位置向上查找 `manifest.json`（安装后位于 `<plugin>/bin/<target>/`，即向上 3 级；`dbx-plugin dev` 下同样能找到项目清单），用清单里的 `id`/`version` 作为自报身份，找不到才回退到编译期常量并在 stderr 打一行诊断。

因此**升版本只改 `manifest.json` 的 `version`**（同时建议把 `backend/main.go` 的 `pluginVersion` 常量作为兜底一起更新）。

```bash
# 验证身份是否与清单一致（无需真机安装；从包内取二进制）
python3 - <<'PY'
import sys, zipfile, subprocess
sys.path.insert(0, 'tools'); import _harness
target = _harness.host_target()
with zipfile.ZipFile(_harness.find_package(target)) as z:
    exe = z.read(f"bin/{target}/{_harness.sidecar_name(target)}")
open('/tmp/sidecar', 'wb').write(exe); __import__('os').chmod('/tmp/sidecar', 0o755)
req = '{"jsonrpc":"2.0","id":1,"method":"plugin/initialize","params":{"host":{"protocolVersions":[1]}}}\n'
print(subprocess.run(['/tmp/sidecar'], input=req, capture_output=True, text=True).stdout)
PY
# → {"id":1,"jsonrpc":"2.0","result":{"capabilities":["connections"],
#     "plugin":{"id":"com.dbx.plugin.imrepo","version":"1.8.0"},"protocolVersion":1}}
```

## 测试

```bash
npm test                            # 下面全部，外加配色门禁
npm run test:settings               # 设置：默认值/持久化/校验/规则生效/Tag 保护/扫描器与缓存
npm run test:layers                 # 镜像层解析：跑真实 Sidecar，断言逐层大小/指令/总量
npm run test:cleanup                # 孤立 Artifact 清理：扫描/删除行为 + 复核安全规则
npm run test:retag                  # 重命名 Tag：断言实际发出的 HTTP 请求序列
npm run test:ui                     # 界面行为：无头浏览器渲染真实 UI，断言 DOM
npm run contrast                    # 配色对比度门禁（WCAG AA + 宿主令牌命名冲突）
npm run i18n                        # 翻译门禁（用到的键必须在两种语言里都存在）
```

四个 Sidecar 测试都跑**打包产物**（`dist/` 里对应当前平台的 `.dbxp` 内的二进制），不是源码编译的临时件；UI 测试渲染的是由真实 `ui/index.html` 生成的验证台。所以先打包再测：

```bash
npm run package && npm test
```

**测试是跨平台的**：`tools/_harness.py` 按当前主机选目标包（`linux-x64` / `windows-x64` / `darwin-arm64` …）、把配置目录隔离到临时目录（Windows 的 `%APPDATA%` 与 POSIX 的 `$XDG_CONFIG_HOME` 一起设，两边的 `os.UserConfigDir()` 都跑不掉）、并找一个 Chromium 系浏览器（`CHROME_HEADLESS_SHELL` 可指定）。找不到浏览器时 UI 测试**跳过而不是假装通过**。

每个测试都会在结束时报出**它实际执行了多少条断言**（`RESULT: ALL PASS (N checks)`），所以下面的数字可以直接跑一遍核对，不必相信文档：

| 测试 | 断言数 | 验证的是 |
|---|---|---|
| `test-settings-e2e.py` | 143 | 设置的持久化、校验与**实际生效**（后端行为）、V2 命名空间与总览、包布局 |
| `test-ui-e2e.py` | 85 | 界面行为与策略可见性（浏览器渲染真实 UI），含总览图表、架构徽章、连接切换、架构读取去重 |
| `test-layers-e2e.py` | 23 | 逐层大小/指令/总量解析 |
| `test-cleanup-e2e.py` | 21 | 孤立 Artifact 清理的安全规则 |
| `test-retag-e2e.py` | 17 | 重命名 Tag 的真实请求序列 |
| `check-contrast.py` | 全量配色对 | 配色对比度门禁 |
| `check-i18n.py` | 275 键 × 2 语言 | 翻译门禁：用到的键必须两种语言都有；另报"定义了但没用到"的键 |

### 翻译门禁（防"界面上显示键名"）

`tools/check-i18n.py` 静态比对三处：`index.html` 的 `data-i18n` 属性、`ui/js/*.js` 里 `t("...")` 的调用、以及 `ui/js/i18n.js` 两份字典的键。它能抓到两类问题：

- **用到的键没定义**：`t()` 找不到键时会**回退返回键名本身**，于是界面上出现字面量 `project.accessDesc` —— 看着像样式问题，不像 bug，而且只在一个弹窗的角落。这条就是这样发现的。
- **两种语言键不对称**：漏翻会静默回退到中文。

它自带一个自检：解析出的键数少于 200 就直接报错退出，而不是"通过"—— 字典结构一旦重构，解析器失效的方向是**少报**（静默通过），必须让它响亮地失败。

### 包布局断言（防回归）

settings 测试的 P 组会读**包内**的 `manifest.json`，断言它的 `entrypoints.backend.executable` 指向包内真实存在的文件。这条断言来自一个真实 bug：手写打包脚本曾把二进制放进 `bin/<target>/`，却让 manifest 仍写着 `bin/imrepo-sidecar` —— 装得上，起不来。整套 Sidecar 测试都测不出来（它们自己解包、自己执行二进制），所以这条断言是唯一的守卫。

- `test-layers-e2e.py` 覆盖 7 组场景，重点是 **BuildKit attestation**：如果 Manifest List 里 `platform: unknown/unknown` 的 attestation 条目排在前面而被选中，拿到的"镜像"层列表是无意义的 —— 表现出来就像"逐层大小功能没做出来"。测试断言此时仍必须解析出真正的镜像（B/C 两组）。
- `test-cleanup-e2e.py` 覆盖扫描准确性（只列出无 Tag 的 IMAGE/CHART，带 Tag 的不列）、删除与回收量、**复核安全规则**（扫描后被重新打标的 Artifact 必须跳过且不发 DELETE）、目标消失时的处理、批量上限、以及非 Harbor 仓库的明确报错。
- `test-ui-e2e.py` 用无头浏览器渲染真实 UI 并断言 DOM，覆盖：**竞态**（点慢仓库 A 后立刻点快仓库 B，最终必须显示 B）、**加载反馈**（内容区与所点行都有转圈）、**预热与缓存**（后台果然请求了若干仓库；点击已预热的仓库只发一次请求）、**清理弹窗**（列出扫描结果、报告扫描统计、未选中时销毁性按钮必须禁用）、**设置面板**（四段齐全、脏值提示、「应用到 Harbor」两步门禁、受保护条目与阈值判定在界面上可见）。竞态那组会在测试内临时摘掉守卫自检灵敏度 —— 摘掉后必须失败。
- `test-settings-e2e.py` 覆盖 9 组场景，重点是**设置真的改变了行为**：默认值 → 保存 → **重启进程后仍在**（证明落盘持久化）→ 按连接隔离 → 校验拒绝非法值且不写入 → 清理规则在扫描与删除两条路径上生效（**受保护的条目不计入删除且不发 DELETE**）→ 受保护 Tag 的删除/改名被拒（**且没有半写状态：不发 PUT**）→ 阈值/缓存/关闭开关 → Harbor 侧扫描器的读取与「只写差异、保留其他键」的写回 → 非 Harbor 仓库的明确报错。测试把配置目录重定向到临时目录，从不碰用户真实配置。

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

设置**存储在侧车进程**，文件位于用户配置目录（如 `~/.config/imrepo-dbx-plugin/settings.json`），按 `connectionId` 分键（同一台机器上两个仓库连接可以有不同策略）。放进后端有两个原因：沙箱 iframe 没有可靠的持久存储，而且**策略必须由后端执行** —— 只被界面记住的规则只是一个约定。

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

大仓库列表要几秒，所以做了四件事，都在 `ui/js/rpc.js` 与 `ui/js/state.js` 里：

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
- 图标一律用内联 SVG（`ui/js/dom.js` 的 `ICONS` + `svgIcon()`）继承 `currentColor`；`◫ / 🛡 / ✕` 这类字形在 13px 下呈细轮廓，观感发虚。
- 作者样式里任何 `display:flex/grid` 都会覆盖 HTML `hidden` 的 UA 默认值，故 `styles.css` 顶部固定有 `[hidden] { display: none !important; }`。

改动配色后必须过门禁（失败返回非 0）：

```bash
python3 tools/check-contrast.py            # WCAG AA 全量校验 + 宿主令牌命名冲突检测
python3 tools/check-contrast.py --verbose  # 打印每一对
```

渲染侧验证（任何 Chromium 系浏览器即可：Edge / Chrome / chrome-headless-shell）：

```bash
# 改了 ui/index.html 或 .preview/mock.js 之后必须重新生成，否则验证台跑的是旧 DOM，
# 会让你误判"功能没生效"（这个坑踩过一次，所以 UI 测试跑前也会自己重新生成）
python3 tools/make-preview.py

# 一次生成 README 用的全部截图（写入 docs/screenshots/）
python3 tools/shoot-screenshots.py
python3 tools/shoot-screenshots.py --list        # 看有哪些镜头
```

`preview.html` 会故意注入宿主那套 Tailwind 令牌，并 mock `invoke()` 数据；镜头通过 URL 参数驱动：

| 参数 | 取值 | 作用 |
|---|---|---|
| `theme` | `light` / `dark` | 主题 |
| `mode` | `harbor` / `docker` | 走 Harbor 项目树还是 V2 命名空间树 |
| `modal` | `retag` / `layers` / `vuln` / `delete` / `pull` / `cleanup` / `settings` | 打开对应弹窗 |
| `overviewtab` | `1` | 切到左侧「总览」tab（图表） |
| `projectsettings` | `1` | 打开项目设置弹窗（可配 `armapply=1` 演示两步确认） |
| `keepuntagged`/`minage`/`excluderepos`/`keeptagged`/`protect`/`threshold` | — | 把界面驱动到"设置已生效"的状态 |
| `rules` | `1` | 清理弹窗的条目带受保护标记与原因 |
| `openlogs`/`newproject` | `1` | 打开日志 / 新建项目弹窗 |

`.preview/preview.html` 由 `tools/make-preview.py` 从真实的 `ui/index.html` 生成（只插入 `<base>` 与 mock 脚本），因此**不存在"验证台 DOM 与真实 UI 脱节"的风险**；要加控件只改 `ui/*`，不要手改生成物。

> 无头环境缺中文字体时，截图里的中文会渲染成方块。装一份 CJK 字体（如 Noto Sans CJK），或让 `XDG_DATA_HOME` 指向一个含 `fonts/` 的目录。

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
| `registry/namespaces` | — | **V2 的"项目"**：把 `_catalog` 的书名按首段（命名空间）分组为 `[{name, repo_count}]`，与 Harbor 项目同形；无斜杠的扁平仓库自成单仓库项目 |
| `registry/repositories` | `namespace` | 命名空间内的仓库 `[{name 短名, full_name}]` |
| `registry/images` | `namespace` | 命名空间总览：并发遍历 Tag→Manifest，**按 digest 去重**计镜像数与总大小 |
| `registry/arches` | `repository`, `reference` | 该引用的架构列表（index 取全部条目的 platform；单架构 manifest 读 config blob 的 `architecture`）。V2 的 Tag 列表不带平台信息，所以架构徽章是懒加载回填的 |
| `registry/overview` | — | V2 仓库总览：命名空间/仓库/镜像/Tag/总大小 + 各命名空间存储分布（无审计日志，故没有拉取次数） |
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
| `harbor/currentUser` | — | 当前登录用户 `{admin, user}`，任何有效登录都可读（界面据此决定用户管理面板是管理员视图还是只读本人信息） |
| `harbor/projectCreate` | `projectName`, `public?` | 新建项目（项目名正则校验，409 = 已存在） |
| `harbor/projectSetPublic` | `project`, `public` | 项目可见性：读取-合并-回写 `metadata.public` |
| `harbor/quotaGet` / `quotaSet` | `project`, `limit?` | 项目存储配额（`hard.storage` 字节；`-1` = 不设限，`0` 拒绝） |
| `harbor/logs` | `project?`, `operation?`, `page?` | 审计日志（全局或按项目，可按操作类型过滤） |
| `harbor/overview` | `window?` | 注册库总览：项目/仓库/镜像/总空间 + 各项目存储分布 + 最近新建 + 拉取最多的项目（拉取数来自审计日志，一次统计 1/3/7 天三个窗口，40 页封顶并以 `pullTruncated` 明示） |

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

## 发布

推一个 `v*` tag 并创建 GitHub Release，CI（`.github/workflows/plugin-release.yml`）会：跑全量测试 → 交叉编译六个平台 → 把每个 `.dbxp` 与汇总的 `release-candidates.json` 传到该 Release。

- **`.dbxp` 不提交进 Git**（`dist/` 已忽略），只作为 Release 附件。
- `release-candidates.json` 是 `dbx-store` 自动更新工作流读取的清单；上架官方商店需要候选包 + 源码 tag +（首次）`.dbx-store.json` 里的展示信息。
- 当前发布的是**未签名候选包**，安装需在插件中心开启「允许安装未签名开发包」。

## 里程碑

- Phase 1（预设 + 多模式认证）✅
- Phase 2（Tag 管理：修改/删除）✅
- Phase 3（Harbor 深度适配：项目树 + 漏洞面板）✅
- Phase 4（打包发布）✅ 六平台候选包 + 发布工作流就绪。

PRD 功能项状态：2.1 连接与预设 ✅ / 2.2 项目与镜像浏览 ✅（Harbor 项目 + V2 命名空间）/ 2.3 Tag 管理与 Manifest 解析 ✅（含重命名）/ 2.4 DevOps 快捷工具与运维 ✅（命令生成器 + 无 Tag 清理）。

PRD 之外的部分（用户后续追加）：总览页签与图表、架构徽章、项目配额、操作日志、新建项目、连接诊断（已于 1.7.0 移除）。

## 许可

[Apache-2.0](LICENSE)。插件使用官方 SDK `github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk`（同样为 Apache-2.0）。
