# IMREPO — Image Registry Studio

> 一个 DBX 插件：在同一个工作台里浏览、管理和检查 OCI / Harbor 容器镜像仓库。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![DBX Store](https://img.shields.io/badge/DBX%20Store-已上架-success)](#安装)
[![Platforms](https://img.shields.io/badge/platforms-windows%20%7C%20linux%20%7C%20macos%20(x64%2Farm64)-informational)](#安装)
[![Plugin API](https://img.shields.io/badge/DBX%20Host%20API-1-informational)](https://dbxio.com/cn/docs/plugin-development)

基于 OCI 标准，兼容 Harbor 与主流开源/闭源镜像仓库：项目与命名空间导航、Tag 重命名与删除、
镜像层逐层解析、Trivy 漏洞报告、仓库总览图表、多架构镜像的结构展示。

## 安装

在 DBX 的**插件中心**搜索 **IMREPO** 即可（插件 ID `com.leavingrain.imrepo`）。商店中的包由 DBX Store
签名，安装时会验证，**不需要开启任何"允许未签名开发包"的开关**。

<details>
<summary>手动安装 / 指定版本</summary>

从 [Releases](https://github.com/Zer0ON1/dbx-plugin-imrepo/releases) 下载对应平台的 `.dbxp`：
`windows-x64` / `windows-arm64` / `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`，
然后在插件中心开启**「允许安装未签名开发包」**。

Release 里放的是**未签名候选包**（即上架用的输入，见[发布](#发布)），内容与商店中的签名包相同；
这条路适合商店版本暂不可用、或需要固定某个版本的时候。
</details>

装好后新建连接，选仓库类型（Harbor / Docker Registry v2 / 云厂商托管 …），填地址与认证方式。

Sidecar 是**静态链接**的 Go 二进制（`CGO_ENABLED=0`），不依赖目标机 libc。已在
**麒麟 V10（aarch64）、openEuler 24.03（amd64）、Windows 11 Enterprise** 实体机上安装使用；
CI 另在 ubuntu / windows / macos 三个真实 runner 上各自跑一遍完整测试套件（测的就是发布用的那批字节）。
细节见 [`docs/DESIGN.md` 的平台支持一节](docs/DESIGN.md#平台支持)。

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

## 仓库类型支持范围

插件按「能力」而非「品牌」组织：所有能走标准 OCI Distribution 接口的功能全类型可用，绑定 Harbor 专有
REST API 的功能只在 Harbor 上出现。**界面上不可用的按钮会置灰并说明原因**，不会静默消失。

| 功能 | Harbor | 通用 OCI v2<br>(Registry / Nexus / Artifactory / Quay / 云厂商托管) | 不可用的原因 |
|---|:---:|:---:|---|
| 仓库与镜像浏览 | ✅ | ✅ | — |
| 命名空间 / 项目树 | ✅ | ✅ | v2 无项目对象，按仓库名首段分组为命名空间 |
| 架构结构展示 | ✅ | ✅ | 两者都按 tag 读一次 manifest（懒加载并缓存）；Harbor 的列表接口不下发平台信息，实测 `platform: null` |
| 每 tag 的 sha256 | ✅ | ✅ | v2 的 `tags/list` 不带 digest，与架构读同一次请求取回 |
| Tag 重命名 | ✅ | ✅ | 重命名 = 写新 Tag + 删原 Tag（OCI 无 rename 原语） |
| Tag 删除 | ✅ | ✅ | 走 OCI `DELETE`（需仓库开启删除；Harbor 用原生接口按 Tag 删） |
| 镜像层逐层解析 | ✅ | ✅ | — |
| 拉取命令生成 | ✅ | ✅ | — |
| 总览图表（存储分布） | ✅ | ✅ | — |
| 总览图表（拉取次数） | ✅ | ❌ | 数据来自 Harbor 审计日志，v2 无 |
| 漏洞报告 (CVE) | ✅ | ❌ | 需要扫描器 API（Harbor/Trivy），v2 协议无此接口 |
| 无 Tag 孤立产物清理 | ✅ | ❌ | **原理上不可实现**：v2 的 `catalog`/`tags` 只暴露有 tag 的 manifest，无法枚举无 tag 的；Harbor 有专有接口才能列出 |
| 新建项目 / 配额 / 成员 / 可见性 | ✅ | ❌ | 这些是 Harbor 的 REST 资源，v2 无对应对象（命名空间是分组视图，不需要创建） |
| 操作日志 | ✅ | ❌ | 同「拉取次数」，审计日志是 Harbor 专有 |
| 用户管理 | ✅ | ❌ | Harbor 的用户体系，v2 无 |

> 云厂商托管仓库（Docker Hub / GHCR / ACR / TCR / ECR）在协议上都是 OCI v2 + 各自的认证方式，
> 因此能力范围与「通用 OCI v2」一列相同；差异只在认证（AK/SK 换临时 Token）与是否提供额外的
> 托管商 API（本插件未对接，因为这些接口不在 OCI 标准内）。

## 安全

### 连接凭据的本地缓存

插件会把**最后一次使用的连接密码**缓存在本地：

| 平台 | 路径 |
|---|---|
| Windows | `%AppData%\imrepo-dbx-plugin\credentials.json` |
| macOS | `~/Library/Application Support/imrepo-dbx-plugin/credentials.json` |
| Linux | `~/.config/imrepo-dbx-plugin/credentials.json`（或 `$XDG_CONFIG_HOME` 下同名路径） |

文件权限为 `0600`（仅属主可读），但 **base64 是编码，不是加密**——能读取该文件的本地进程或
用户即可还原出密码。这与 `~/.docker/config.json` 的威胁模型相同。

**为什么会缓存**：DBX 宿主在重连时可能不再下发连接密钥，没有这份缓存，成员管理、产物清理、
漏洞报告等需要认证的操作会全部失败。这是插件在"功能可用"与"不在本地留存凭据"之间做的取舍。

**你可以怎么做**：

- 不需要时直接删除该文件，插件会在下一次需要时重新写入；
- 更稳妥的做法是为此类连接使用**权限最小化的账号**——Harbor robot account 或只读令牌，
  而不是管理员账号。插件的大多数功能（浏览、镜像层、架构、漏洞报告、拉取命令）只需要读权限。

### 其他

- **凭据不经插件 UI**：工作台只持有 `connectionId`，密钥由宿主在生命周期请求中下发给 sidecar。
- **密钥不落日志**：`stderr` 只输出诊断信息，不含密码或令牌。
- **删除是软删除**：删除 Tag / Artifact 只解除引用，磁盘空间需由注册库执行 GC 回收——
  插件提供了 Harbor GC 的查看与触发入口，见「设置 → 镜像回收 (GC)」。

## AI 助手工具

插件向 **DBX 内置 AI 助手**（Agent 模式）提供工具，全部走标准 MCP 协议。**默认关闭**：需要在
「插件中心 → 已安装 → 内置 AI 工具」里显式开启，仅安装不会暴露任何东西。

| 工具 | 作用 | 需确认 |
|---|---|:---:|
| `list_projects` | 列项目（Harbor）或命名空间（v2） | — |
| `list_repositories` | 列某项目下的仓库 | — |
| `list_tags` | 列 tag：digest / 大小 / **架构** / 推送时间（默认最近 50 个，可调） | — |
| `image_info` | 单个镜像：digest、大小、平台、层数、推送时间 | — |
| `vulnerabilities` | CVE 汇总与阈值判定（仅 Harbor） | — |
| `create_project` | 新建项目（仅 Harbor） | ✅ |
| `set_project_public` | 切换项目可见性（仅 Harbor） | ✅ |
| `retag` | 重命名 tag | ✅ |
| `delete_tag` | 删除 tag | ✅ |

### 安全边界

- **只读工具**标了 `readOnlyHint`，可直接执行；**写操作**每次调用都会由宿主弹出**完整参数**让用户
  选择允许一次或拒绝（5 分钟无响应视为拒绝）。
- **插件自己的规则不因宿主确认而放宽**：例如删除受保留策略保护的 tag，即使宿主层面用户点了允许，
  插件仍会拒绝并说明是哪条规则拦下的。工具调用的是**工作台同一套后端函数**，不是另开一条路径——
  这条是设计底线，否则策略引擎会被绕过。
- **凭据不经工具参数**：连接信息由宿主在 `lifecycle` 里下发（与连接建立时同一载荷），模型看不到
  也无需提供任何密钥。
- 工具只在**用户已打开的连接**上工作，且 `external_tools` 关闭——这些工具**不会**出现在
  Claude Code / Cursor 等外部 MCP 客户端上。

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

已上架 **DBX 官方商店**（插件 ID `com.leavingrain.imrepo`）。商店条目与签名产物列表见
[`catalog/index.json`](https://dl.dbxio.com/catalog/index.json)（`dl.dbxio.com` 上的包由 DBX Store
签名，DBX 安装前会验证该签名）。

发一个新版本：

1. 改 `manifest.json` 的 `version`（唯一需要改的地方，见 [`docs/DESIGN.md`](docs/DESIGN.md#版本号只需改一个地方)）
2. 推一个 `v*` tag，并**创建 GitHub Release**——CI（`.github/workflows/plugin-release.yml`）会跑全量测试
   → 交叉编译六个平台 → 把 6 个 `.dbxp` 与汇总的 `release-candidates.json` 传到该 Release
3. 候选元数据提交给 [t8y2/dbx-store](https://github.com/t8y2/dbx-store)（首次是手工 PR；登记
   `autoUpdate: true` 后由同步工作流自动开 PR）
4. 维护者审核后跑签名工作流：校验字节 → 签名 → 发布到 `dl.dbxio.com` → 更新目录条目

几个约束值得记住：

- **`.dbxp` 不提交进 Git**（`dist/` 已忽略），只作为 Release 附件。Release 上是**未签名候选包**，
  商店分发的是签名后的副本。
- **Release 附件一旦上传就不可修改**。字节变了（哪怕只是重新打包），候选里的 `sha256`/`size` 就对不上，
  签名会直接拒绝——必须**重发 Release 并更新候选元数据**。
- 候选元数据里的 `id`/`version`/`publisher` 必须与包内 `manifest.json` 一致，否则同样被拒。

## 文档

- [`docs/DESIGN.md`](docs/DESIGN.md) — 架构、后端 RPC 方法表，以及若干**设计取舍**：打包路径
  为什么必须按目标改写、主题令牌为什么用私有前缀、为什么用 classic script 而不是 ES module、
  策略为什么必须落在后端、清理无 Tag 的安全设计。
- [`CHANGELOG.md`](CHANGELOG.md) — 版本变更。

## 许可

[Apache-2.0](LICENSE)。插件使用官方 SDK `github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk`（同为 Apache-2.0）。
