# IMREPO — Image Registry Studio

> 一个 DBX 插件：在同一个工作台里浏览、管理和检查 OCI / Harbor 容器镜像仓库。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-windows%20%7C%20linux%20%7C%20macos%20(x64%2Farm64)-informational)](#安装)
[![Plugin API](https://img.shields.io/badge/DBX%20Host%20API-1-informational)](https://dbxio.com/cn/docs/plugin-development)

基于 OCI 标准，兼容 Harbor 与主流开源/闭源镜像仓库：项目与命名空间导航、Tag 重命名与删除、
镜像层逐层解析、Trivy 漏洞报告、仓库总览图表、多架构镜像的结构展示。

## 安装

1. 从 [Releases](https://github.com/Zer0ON1/dbx-plugin-imrepo/releases) 下载对应平台的 `.dbxp`：
   `windows-x64` / `windows-arm64` / `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`。
2. 在 DBX 插件中心开启**「允许安装未签名开发包」**（当前是未签名候选包，见[发布](#发布)）。
3. 新建连接，选仓库类型（Harbor / Docker Registry v2 / 云厂商托管 …），填地址与认证方式。

Sidecar 是**静态链接**的 Go 二进制（`CGO_ENABLED=0`），不依赖目标机 libc。CI 在
**ubuntu / windows / macos 三个真实 runner** 上各自跑一遍完整测试套件（测的就是发布用的那批字节），
Linux 侧另有麒麟 V10（aarch64 / glibc 2.28 / 内核 4.19）真机复验。细节见
[`docs/DESIGN.md` 的平台支持一节](docs/DESIGN.md#平台支持)。

## 功能

| 模块 | 说明 |
|------|------|
| 连接与预设 | Harbor / Registry v2 / Docker Hub / GHCR / Aliyun ACR / Tencent TCR / AWS ECR / Azure ACR / Nexus / Artifactory / Quay |
| 多元认证 | Basic/密码、Harbor Robot、Bearer/PAT、云厂商 AK/SK（AWS SigV4、Aliyun HMAC-SHA1、Tencent TC3）、免认证 |
| 仓库浏览 | Harbor 项目树 / 通用 `_catalog` 列表 / **V2 命名空间树**（V2 无项目对象，按仓库名首段归类），模糊搜索 |
| 项目与镜像总览 | 点项目「文件夹」即列出该项目**跨仓库聚合**的全部镜像：镜像数/总大小/仓库数/Tag 数 + 按推送时间降序的列表 |
| **总览页签与图表** | 统计卡 + SVG 横向柱状图（Harbor：拉取最多的项目、项目存储分布；V2：命名空间存储分布） |
| **架构结构展示** | 多架构镜像按平台逐个展示为**一个圆圈徽章**（`linux/amd64`、`linux/arm64`…），V2 侧懒加载回填 |
| Tag 管理 | Tag 列表、**重命名**（写新 Tag + 删原 Tag）、删除（OCI DELETE / Harbor 原生） |
| 镜像层解析 | Manifest → Index → Config Blob 逐层指令；每层大小（占比条 + 百分比 + 最大层高亮 + 按大小排序） |
| 漏洞报告 | Harbor/Trivy CVE 分级统计 + **按设置阈值判定**「已达/未达阈值」+ 缓存 + 刷新/触发扫描 |
| 运维清理 | **清理无 Tag 孤立 Artifact**：只读扫描 → 列清单（含大小与合计）→ 勾选确认 → 逐个**复核后**删除；受规则保护的条目不可选并给出原因 |
| 设置 | 全局（用户管理/扫描器/关于）+ 项目级（可见性、配额、成员与角色、回收策略、本项目扫描器），按连接持久化，**由后端强制执行** |
| 快捷工具 | 拉取命令弹窗：镜像地址 / docker / nerdctl / crictl / podman / ctr / docker login，点整行即复制 |
| 加载体验 | 展开项目后台预热前 6 个仓库；列表 60s 缓存 + 请求去重；**慢响应不会覆盖后点的仓库** |
| Harbor 自动识别 | 类型选成 Docker Registry v2 但服务器其实是 Harbor 时，探测 `/api/v2.0/ping` 自动启用 Harbor 功能 |

## 开发

依赖：Node.js 22+、Go 1.22+、Python 3（仅脚本用）。

```bash
npm install                 # 插件 CLI（自带与本版本匹配的 Go SDK）
npm run package             # 交叉编译六个平台 → dist/*.dbxp + release-candidates.json
npm run preview             # 生成验证台 .preview/preview.html
npm test                    # 全量：包门禁 + 5 套端到端 + 配色门禁 + 翻译门禁

npx dbx-plugin dev --path . --port 5190      # 本地调试宿主 → http://127.0.0.1:5190/
```

一条命令出全部平台，因为 `CGO_ENABLED=0` 让 Sidecar 静态链接、与构建机 libc 无关。官方 CLI
`dbx-plugin package .` 只出**当前平台**的包（拒绝交叉编译），所以多平台由
`tools/build-packages.py` 负责，它会按目标平台**改写 manifest 的 `entrypoints.backend.executable`**
并给二进制打 0755。官方 CLI 的产物可用来验收：两者的 `manifest.json` 应当逐字节一致。

### 测试

四个 Sidecar 测试跑**打包产物**（`dist/` 里对应当前平台的 `.dbxp` 内的二进制），UI 测试用无头
浏览器渲染真实 `ui/index.html`。测试是跨平台的：`tools/_harness.py` 按主机自动选包、把配置目录
隔离到临时目录、并找一个 Chromium 系浏览器（优先 `chrome-headless-shell`，可用 `CHROME_HEADLESS_SHELL` 指定；本机找不到会跳过，**CI 里找不到则直接失败**——跳过与通过无法区分）。

每个测试报出**实际执行的断言数**（`RESULT: ALL PASS (N checks)`），下面的数字可以跑一遍核对：

| 测试 | 断言数 | 验证的是 |
|---|---|---|
| `test-settings-e2e.py` | 144 | 设置的持久化、校验与**实际生效**（后端行为）、V2 命名空间与总览、包布局 |
| `test-ui-e2e.py` | 86 | 界面行为与策略可见性，含总览图表、架构徽章、连接切换、架构读取去重 |
| `test-layers-e2e.py` | 23 | 逐层大小/指令/总量解析 |
| `test-cleanup-e2e.py` | 21 | 孤立 Artifact 清理的安全规则 |
| `test-retag-e2e.py` | 17 | 重命名 Tag 的真实请求序列 |
| `check-contrast.py` / `check-i18n.py` | 全量配色对 / 275 键×2 语言 | 配色对比度门禁、翻译门禁 |
| `check-packages.py` | 6 个目标 | 每个包二进制的格式/架构/签名与 manifest 路径是否与其平台相符 |
| `check-browser-baseline.py` | 34 个特性 | UI 是否用了新于 Chrome 109 的 CSS/JS 特性（DBX 的最低引擎） |

## 目录结构

```
dbx-plugin-imrepo/
├── manifest.json        # 插件清单：connection-provider + workbench + backend（版本号在这里）
├── dbx-plugin.toml      # 构建配置（[backend] Go + [package].include）
├── assets/              # 插件级图标
├── ui/                  # 工作台 UI（沙箱 iframe，classic script + window.IMREPO）
│   ├── index.html       # 按依赖顺序加载 js/*（不用 ES module，见 docs/DESIGN.md）
│   ├── styles.css       # 明/暗主题调色板（私有 --im-* 令牌）
│   └── js/              # 19 个模块：state / i18n / dom / format / rpc / render-* / main
├── backend/             # Go Sidecar
│   ├── main.go          # SDK 入口 + 身份解析（从包内 manifest 读 id/version）
│   ├── dispatch.go      # RPC 方法表：51 个方法一览即 API 面
│   ├── connection.go    # 连接生命周期与宿主 payload 解析
│   ├── oci.go           # OCI Registry v2 客户端（含 token-challenge）
│   ├── harbor.go        # Harbor REST v2.0 客户端
│   ├── v2projects.go    # V2 命名空间视图（"项目" = 仓库名首段）
│   ├── cleanup.go / retag.go / layers.go    # 清理、重命名、镜像层解析
│   ├── scanner.go / settings.go             # CVE 报告与扫描器；设置与策略引擎
│   ├── registry.go / admin.go               # 项目生命周期；管理面板聚合
│   ├── session.go / types.go / pool.go      # 会话、连接解析、有界并发
│   └── credentials.go / auth.go / cloud.go  # 凭据兜底与各认证方式
├── tools/               # 开发脚本（Python，无第三方依赖）
│   ├── _harness.py      # 测试公共件（选包/隔离配置/找浏览器/断言计数）
│   ├── build-packages.py / make-preview.py / shoot-screenshots.py
│   └── check-packages.py / check-browser-baseline.py / check-contrast.py
│       / check-i18n.py / test-*-e2e.py
├── .preview/mock.js     # 验证台的 mock 桥（源文件，要提交）
├── docs/                # 设计文档
└── CHANGELOG.md
```

## 发布

推一个 `v*` tag 并创建 GitHub Release，CI（`.github/workflows/plugin-release.yml`）会：跑全量测试
→ 交叉编译六个平台 → 把每个 `.dbxp` 与汇总的 `release-candidates.json` 传到该 Release。

- **`.dbxp` 不提交进 Git**（`dist/` 已忽略），只作为 Release 附件。
- `release-candidates.json` 是 `dbx-store` 自动更新工作流读取的清单。
- 当前是**未签名候选包**，安装需在插件中心开启「允许安装未签名开发包」。

## 文档

- [`docs/DESIGN.md`](docs/DESIGN.md) — 架构、后端 RPC 方法表，以及若干**设计取舍**：打包路径
  为什么必须按目标改写、主题令牌为什么用私有前缀、为什么用 classic script 而不是 ES module、
  策略为什么必须落在后端、清理无 Tag 的安全设计。
- [`CHANGELOG.md`](CHANGELOG.md) — 版本变更。

## 许可

[Apache-2.0](LICENSE)。插件使用官方 SDK `github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk`（同为 Apache-2.0）。
