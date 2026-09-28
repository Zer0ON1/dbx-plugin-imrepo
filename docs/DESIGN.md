# 设计与实现说明

这份文档收录 README 放不下的深度内容：架构、后端 RPC 方法表、以及若干**设计取舍**——
尤其是那些看着奇怪、但换了写法就会出问题的约定（打包路径改写、主题令牌命名、classic script
而非 ES module、策略必须落在后端）。初次阅读不必从头看到尾，按需查即可。

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

## 前端

### 为什么前端不用 ES module

工作台也通过 `file://` 打开（验证台与 UI 测试都这么加载）。Chromium 对 `file://` 下的 `type="module"` 脚本按 CORS（origin 为 null）**直接拒绝加载**——用了模块，整套 UI 测试与截图流程会静默失效。因此拆成多个 **classic script**，每个文件挂到共享的 `window.IMREPO` 命名空间上，跨模块调用一律 `IM.xxx`；所有可变的共享状态（`state`、`archCache`、`locale`、`pendingDelete` 等）也挂在命名空间上，否则每个模块会各持一份副本。

`index.html` 里 `<script>` 的顺序即依赖顺序（state → i18n → dom/format → rpc → settings-model → 各 render-* → main），**`main.js` 必须最后**（它调用 `init()`）。

## 构建与发布的约定

### 版本号：只需改一个地方

宿主会校验后端自报身份与清单是否一致，不一致直接拒绝初始化：

```
Plugin backend identity 'com.leavingrain.imrepo/1.2.0' does not match manifest 'com.leavingrain.imrepo/1.2.1'
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
#     "plugin":{"id":"com.leavingrain.imrepo","version":"0.1.1"},"protocolVersion":1}}
```

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

## 功能设计取舍

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

### 仓库类型的功能边界

按「协议能力」组织，而不是按「品牌」分支：所有功能都先问"这需要 OCI Distribution 的哪一部分"。

- **纯 OCI v2 能给的一律给全** —— 浏览、Tag 增删改、镜像层、架构、digest、拉取命令、存储图表。
  有些需要额外一次请求（v2 的 `tags/list` 不带 digest，也不带平台信息），就与已有的一次 manifest
  读合并，不额外发请求。
- **只有 Harbor 专有 REST 能给的，就明确不给**，并在界面上说明原因（按钮置灰 + 悬停文案），而不是
  让它消失。消失的按钮教不会用户任何东西；"这个仓库类型没有审计日志"才是用户需要知道的。
- 其中一条是**原理上的不可能**，值得单独记住：**无 Tag 清理在 v2 上无法实现**。OCI Distribution
  的 `catalog` 与 `tags/list` 只暴露"有 tag 的" manifest，没有任何标准接口能枚举孤立 manifest ——
  Harbor 能列出是因为它有专有接口。这不是"还没做"，是"协议里没有"。

完整对照表见 README 的「仓库类型支持范围」。

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

# 生成全部界面的截图（写入 docs/screenshots/，该目录已被 gitignore）
# 截图内容来自 .preview/mock.js 的示例数据，可能含真实环境信息 —— 不要提交
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

## 平台支持

一个带原生 sidecar 的插件，商店里那个"下载"按钮背后其实是**每个目标平台一个包**，由宿主挑：

- 宿主用 `current_plugin_target()`（`crates/dbx-plugin-runtime/src/plugins/manifest.rs`）在运行时算出自己是谁：
  `std::env::consts::OS/ARCH` 再映射两个名字 —— `macos → darwin`、`x86_64 → x64` —— 得到 `windows-x64`、`darwin-arm64` 这类目标名。
- 再从 catalog 的 `version.artifacts[]` 里挑（`marketplace.rs` 的 `select_marketplace_artifact`）：**先精确匹配目标名，再回退 `universal`**；都不中就直接报
  `Plugin '<id>' version '<v>' does not support target '<t>'`。
- 因此**带原生 sidecar 的插件不能用 `universal`**，必须逐平台提供（`universal` 是纯前端插件的形态）。
- 挑中之后：校验 catalog 里钉死的 sha256/size → 校验包内 DBX Store 的 Ed25519 签名 → 校验 manifest 身份 →
  解包 → **按 manifest 里 `entrypoints.backend.executable` 的字面路径**启动二进制。

本项目发六个目标：

| target | 二进制格式 | 说明 |
|---|---|---|
| `windows-x64` / `windows-arm64` | PE | 包内文件名带 `.exe`，manifest 路径同步改写 |
| `linux-x64` / `linux-arm64` | ELF | 静态链接，老发行版（如麒麟 V10，glibc 2.28）可直接跑 |
| `darwin-x64` / `darwin-arm64` | Mach-O | 见下 |

### macOS 的两个硬约束

1. **`darwin-arm64` 必须有代码签名**。Apple Silicon 上 macOS 拒绝执行未签名的 arm64 代码 ——
   不是"弹个警告"，是直接起不来。Go 链接器会**自动施加 ad-hoc 签名**（`LC_CODE_SIGNATURE`），
   所以交叉编译出来的包是可用的；但这是**逐目标**行为，`darwin-x64` 就没有（Intel/Rosetta 接受未签名 x86_64）。
   `tools/check-packages.py` 把这条断言下来，因为它的失败表现是"安装成功、启动即死"，很难当场归因。
2. **Gatekeeper 隔离属性（`com.apple.quarantine`）** 由浏览器等下载器打上，而 DBX 用自己的 HTTP 客户端下载、
   自己解包（Rust zip），宿主运行时里也没有任何 `xattr`/`codesign` 处理 —— 所以正常从插件中心安装不会带隔离属性。
   只有"浏览器手动下载 .dbxp 再安装"这种路径才可能引入，届时需要 `xattr -d com.apple.quarantine` 处理。

### 浏览器基线：Chrome 109

沙箱 UI 跑在宿主自带的引擎里，而 **DBX 支持的最低版本是 Chrome 109**（2023 年 1 月）。
CSS 没有特性检测 —— 不认识的属性和函数会被**直接丢弃**，所以用新语法写出来的样式在旧引擎上会静默降级：
颜色没了、某条布局规则不生效，而且因为没人在最低版本上测，谁也不会发现。

`tools/check-browser-baseline.py` 把这条约束固化下来：静态扫描 `ui/` 是否用到 **34 个** 有版本门槛的 CSS/JS 特性，
凡最低版本高于 109 就失败。刻意**不禁止**，而是要求"要么别用，要么写回退并在 `ACKNOWLEDGED` 里登记理由"——
增加一行说明是有意的摩擦，让人做出选择而不是无意识地引入。

当前唯一登记的是 `scrollbar-width` / `scrollbar-color`（Chrome 121）：紧邻的 `::-webkit-scrollbar` 规则
（Chrome 4+）在更老的引擎上样式同一个滚动条，109 上只是少了个新写法，外观不退化。

**这是静态检查，不是渲染验证** —— 它能证明代码没有伸手去拿 109 没有的东西，
但不能证明布局在 109 上"看起来对"。后者需要一个真的 109 环境（Chrome for Testing 官方归档只回溯到 113，
所以 CI 里也拿不到）。

### UI 测试统一用同一个无头浏览器

CI 的三个 runner **都装同一个 `chrome-headless-shell`**，而不是各用系统自带的 Chrome/Edge。
理由是一次真实的失败：macOS runner 上用完整版 Chrome + `--headless=new` 跑 `--dump-dom` + `--virtual-time-budget`，
**进程写出输出后不退出**，把调用方阻塞到 180 秒超时（Linux 上用 headless shell 从来复现不了）。

`chrome-headless-shell` 是旧的 headless 实现，`--dump-dom` 与虚拟时间预算在上面行为明确；它也是纯无头二进制，
没有完整浏览器那套首启动/钥匙串/GPU 进程树。除此之外测试还做了三件事，都是为了"浏览器卡住时能明确失败"：

- 传 `--timeout`（墙钟上限）让 Chrome 到点就 dump，而不是等页面空闲；
- 子进程放进**独立进程组**，超时按组 SIGKILL —— 只杀父进程会留下持有管道的子进程，这正是"调用方被永久阻塞"的成因；
- DOM 返回前校验（必须含 `<html`）。**空字符串会让 `"X" not in dom` 这类断言全部通过** —— 浏览器什么都没渲染会被当成测试通过。

### 验证到什么程度

不同平台的"可用"证据强度不同，这里如实标注：

| 平台 | 构建 | 二进制格式/签名/路径 | 真实执行 |
|---|---|---|---|
| linux-x64 | 本机构建 | ✅ 门禁 | ✅ 本机全套 290 项断言 |
| linux-arm64 | 交叉编译 | ✅ 门禁 | ✅ **真机**（麒麟 V10 aarch64 / glibc 2.28）204 项断言 |
| windows-x64 / arm64 | 交叉编译 | ✅ 门禁 | CI 的 `windows-latest` 上跑全套 |
| darwin-x64 / arm64 | 交叉编译 | ✅ 门禁（含 arm64 签名断言） | CI 的 `macos-latest` 上跑全套 |

`tools/check-packages.py` 是**读**二进制而不是执行它，所以在任何主机上都能跑 —— 它覆盖的是
"跨平台编译参数写错 / manifest 路径没按目标改写 / POSIX 包忘了给可执行位"这类**只有到用户机器上才炸**的问题。
真正执行由 CI 矩阵负责：三个 runner 测的是**同一批构建产物**，所以证明了发布用的字节确实能在三种系统上跑起来。


## 安全说明

- 凭证仅在 `connection/test`、`connection/connect` 等生命周期请求中由宿主传入，Sidecar 按 `connection.id` 缓存会话，UI 不接触任何密钥。
- 云厂商 AK/SK 仅用于换取临时凭证，不落盘、不写入日志（stderr 仅输出诊断）。
- 删除为软删除（解除 Tag 与 Manifest 绑定），空间回收需仓库侧执行 GC，UI 已做二次确认与提示。
