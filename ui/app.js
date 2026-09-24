/* IMREPO workbench — vanilla JS, runs inside the DBX sandboxed iframe. */
(function () {
  "use strict";

  const state = {
    connectionId: null,
    connInfo: { name: "", endpoint: "", type: "" },
    mode: "docker-v2", // "harbor" | "docker-v2"
    search: "",
    sidebarTab: "projects", // "projects" | "overview" (left-sidebar tabs)
    projects: [],
    repos: [], // repos of the currently selected project (harbor) OR catalog (docker-v2)
    expandedProject: null,
    current: { project: null, repo: null }, // repo.full_name for OCI, repo.name for Harbor
    artifacts: [],
    tags: [],
    projectImages: null, // project-level image overview (all artifacts across the project)
    projectAdmin: null,  // harbor/projectAdmin result for the per-folder settings dialog
    overview: null,      // harbor/overview result for the sidebar overview tab
    overviewWindow: 7,   // pull-count window (days) shown in the overview stats

    /* --- loading / caching -------------------------------------------------
     * A big repository can take seconds to list, so:
     *  - every fetch is cached and deduplicated per repository (cache/inflight);
     *  - listing a project warms the first few repositories in the background;
     *  - viewSeq guards the view: only the newest selection may paint. Without
     *    it, a slow response for repository A lands after you have clicked B and
     *    paints A's artifacts under B's name.
     */
    cache: new Map(),        // key -> { data, at }
    inflight: new Map(),     // key -> Promise (dedupes concurrent fetches)
    loadingKeys: new Set(),  // keys with an outstanding request, for row spinners
    viewSeq: 0,
    prefetchQueue: [],
    prefetching: false,
    reposLoading: false,     // the expanded project is fetching its repository list

    /* --- settings ----------------------------------------------------------
     * settings  : last values read from the backend (authoritative)
     * draft     : working copy the form edits, so Cancel discards edits
     * scannerInfo: what Harbor reports right now (scanners, project policy)
     */
    settings: null,
    settingsDraft: null,
    settingsDirty: false,
    settingsPath: "",
    settingsIsDefault: false,
    appInfo: null,
    scannerInfo: null,
    scannerError: null,
    applyArmed: false,
    applySeverity: false,
    vulnSeq: 0,          // same guard as the sidebar: a slow report must not win
    vulnRef: null,
  };

  const CACHE_TTL_MS = 60_000;   // stale enough to be free, fresh enough to trust
  const PREFETCH_LIMIT = 6;      // repositories warmed per project

  const I18N = {
    "zh-CN": {
      refresh: "刷新", explorer: "资源浏览", search: "搜索仓库 / 项目...",
      "empty.title": "连接一个镜像仓库以开始浏览",
      "empty.sub": "在左侧选择项目或仓库，查看镜像 Tag、镜像层与安全漏洞报告",
      retag: "重命名 Tag", delete: "删除", layers: "镜像层", vuln: "漏洞", pull: "拉取命令",
      cancel: "取消", close: "关闭", "retag.title": "重命名 Tag（Retag）",
      "retag.repo": "仓库", "retag.source": "原 Tag", "retag.target": "新 Tag",
      "retag.deleteSource": "同时删除原 Tag（完成重命名）",
      "retag.ociNotice": "当前为通用 OCI v2 仓库：只能新增 Tag，原 Tag 需手动删除。",
      "retag.hint": "无需重新上传镜像层，仅将原 Manifest 以新 Tag 写回仓库。",
      "retag.targetInvalid": "Tag 只能含字母/数字/下划线/点/短横线，且不能以点或短横线开头",
      "retag.targetSame": "新 Tag 与原 Tag 相同",
      "retag.renamed": "已重命名", "retag.copied": "已新增 Tag（原 Tag 保留）",
      "retag.confirm": "确认重命名",
      "delete.title": "删除确认", "delete.hint": "删除为软删除（解除 Tag 与 Manifest 绑定），空间回收需仓库侧执行 GC。",
      "delete.confirm": "确认删除",
      "layers.title": "镜像层解析", "vuln.title": "安全漏洞报告 (CVE)",
      loading: "加载中...", noData: "暂无数据", copied: "已复制到剪贴板",
      copyFailed: "复制失败", done: "操作成功", failed: "操作失败",
      copy: "复制", "copy.done": "已复制",
      "pull.title": "拉取命令", "pull.sub": "选择要复制到剪贴板的命令。",
      "pull.image": "镜像地址", "pull.login": "登录仓库",
      cleanup: "清理无 Tag", "cleanup.title": "清理无 Tag 的孤立镜像",
      "cleanup.repository": "仓库",
      "cleanup.sub": "以下 Artifact 没有任何 Tag 指向，只能通过 digest 访问，删除后不影响任何 Tag。删除为软删除，空间回收需仓库侧执行 GC。",
      "cleanup.project": "项目", "cleanup.scanned": "已扫描仓库", "cleanup.found": "无 Tag Artifact",
      "cleanup.reclaim": "可回收", "cleanup.none": "没有发现无 Tag 的 Artifact。",
      "cleanup.truncated": "仓库数超过扫描上限，本次只扫描了前 100 个仓库。",
      "cleanup.repoErrors": "部分仓库读取失败（已跳过）",
      "cleanup.selectAll": "全选", "cleanup.confirm": "清理选中", "cleanup.working": "清理中...",
      "cleanup.deleted": "已清理", "cleanup.reclaimed": "回收", "cleanup.skipped": "已跳过",
      "cleanup.failedCount": "失败", "cleanup.nothingSelected": "请至少选择一条",
      "cleanup.needProject": "请先在左侧选择一个项目",
      "cleanup.needHarbor": "仅 Harbor 支持按 digest 删除 Artifact；通用 OCI v2 无法列出无 Tag 的 Manifest",
      repo: "仓库", tag: "Tag", size: "大小", arch: "架构/OS", pushed: "推送时间",
      pullCount: "拉取次数", tags: "Tag 数", updated: "更新时间", public: "公开",
      untagged: "无 Tag 镜像 (清理)", noVuln: "未发现漏洞或未启用扫描", severity: "严重性",
      layersTotal: "总大小", layersCount: "层数", layersPlatform: "平台", digest: "Digest",
      layersBiggest: "最大层", layersBiggestTag: "最大", layersOfTotal: "占比",
      layersSort: "排序", layersByOrder: "原始顺序", layersBySize: "按大小",
      layersNoCommand: "(无指令)",
      layersNone: "该 Manifest 不含镜像层（可能是索引、Helm Chart 或 attestation）",
      imagesCount: "镜像数", imagesSize: "总大小", imagesRepos: "仓库数", imagesTags: "Tag 数",
      imagesOpenRepo: "点击查看该仓库的 Tag",
      arch: "架构",
      imagesActions: "操作", imagesTruncated: "仓库数超过扫描上限，本次仅展示前 100 个仓库的镜像。",
      imagesErrors: "部分仓库读取失败（已跳过）",
      "project.settings": "项目设置", "project.members": "项目成员", "project.memberAdd": "添加成员",
      "project.memberUser": "用户", "project.memberRole": "角色", "project.memberEmpty": "暂无成员",
      "project.retention": "回收策略（Tag 保留）", "project.retentionNone": "未配置保留策略",
      "project.retentionHint": "先读取已有策略，保存时写回完整策略。",
      "project.retentionKeep": "保留最近 N 个 Tag", "project.retentionDays": "保留最近 N 天推送的 Tag",
      "project.retentionCron": "执行时间（cron）", "project.retentionSave": "保存保留策略",
      "project.retentionSaved": "保留策略已保存", "project.public": "公开项目", "project.publicDesc": "公开项目任何人可拉取；私有项目需登录认证。",
      "project.publicLabel": "设为公开", "project.publicSaved": "项目可见性已更新",
      "project.loadFailed": "读取项目设置失败", "project.onlyHarbor": "仅 Harbor 支持项目权限与回收策略",
      "user.manage": "用户管理", "user.username": "用户名", "user.email": "邮箱",
      "user.realname": "真实姓名", "user.password": "密码", "user.newPassword": "新密码",
      "user.admin": "管理员", "user.create": "创建用户", "user.created": "用户已创建",
      "user.delete": "删除", "user.deleteConfirm": "确认删除该用户？此操作不可恢复。",
      "user.passwordSet": "密码已修改", "user.none": "暂无用户", "user.comment": "备注",
      "user.setPwd": "修改密码",
      "user.setAdmin": "设为管理员", "user.readonlyHint": "当前账号不是系统管理员，仅显示本人信息。",
      "role.1": "项目管理员", "role.2": "开发者", "role.3": "访客", "role.4": "维护者", "role.5": "受限访客",

      settings: "设置", "settings.title": "设置",
      "settings.save": "保存设置", "settings.reset": "恢复默认", "settings.resetArm": "再点一次恢复默认",
      "settings.saved": "设置已保存", "settings.scope": "按连接保存，只影响当前仓库连接。",
      "settings.stored": "已保存到", "settings.defaults": "当前为默认配置",
      "settings.noConnection": "当前没有活动连接：设置会写入「默认」配置，连接后请再检查一次。",
      "settings.dirty": "有未保存的更改",
      "settings.cleanup": "条件清理", "settings.cleanup.desc": "决定「清理无 Tag」能提出哪些候选；被规则保护的条目在弹窗里不可勾选。",
      "settings.keepUntagged": "每个仓库保留最近几个无 Tag 产物", "settings.keepUntagged.help": "0 = 不保留，全部可清理",
      "settings.minAgeDays": "只清理早于 N 天的产物", "settings.minAgeDays.help": "0 = 不限时间",
      "settings.excludeRepos": "永不清理的仓库", "settings.excludeRepos.help": "每行一个，支持 * 通配，例如 libs/*、internal-*",
      "settings.maxReposPerScan": "单次扫描仓库上限", "settings.maxReposPerScan.help": "1-500，防止大项目变成无边界扫描",
      "settings.retention": "保留策略", "settings.retention.desc": "受保护的 Tag 无法删除，也不能通过重命名连带删除；由后端强制执行。",
      "settings.keepTagged": "每个仓库保留最近几个产物", "settings.keepTagged.help": "0 = 不标记。仅用于界面提示，不会自动删除。",
      "settings.protectTags": "受保护的 Tag", "settings.protectTags.help": "每行一个，支持 * 通配，例如 latest、release-*",
      "settings.enforced": "后端强制",
      "settings.scanner": "镜像扫描器", "settings.scanner.desc": "漏洞数据来自 Harbor 的扫描结果；这里的阈值与缓存决定面板怎么判定、多久复用。",
      "settings.scannerSource": "扫描数据源", "settings.scannerSource.harbor": "Harbor 内置扫描", "settings.scannerSource.off": "关闭漏洞面板",
      "settings.threshold": "需要关注的等级阈值", "settings.sev.critical": "Critical（紧急）", "settings.sev.high": "High（高）", "settings.sev.medium": "Medium（中）", "settings.sev.low": "Low（低）",
      "settings.cacheSeconds": "漏洞报告缓存（秒）", "settings.cacheSeconds.help": "0 = 每次重新获取",
      "settings.live": "Harbor 当前状态", "settings.scanners": "可用扫描器", "settings.projectScanner": "项目扫描器",
      "settings.projectScanner.follow": "跟随系统默认", "settings.autoScan": "推送时自动扫描",
      "settings.preventVul": "阻止拉取含高危漏洞的镜像", "settings.severityOnHarbor": "同时写入 Harbor 的 severity 阈值",
      "settings.apply": "应用到 Harbor", "settings.applyArm": "再点一次确认写入", "settings.applyHint": "将写入 Harbor 项目 {project}：{items}",
      "settings.applyNothing": "没有需要写入的项", "settings.applied": "已写入 Harbor", "settings.notes": "提示",

      "stab.projects": "项目", "stab.overview": "总览",
      overview: "总览", logs: "日志", newProject: "新建项目",
      "ov.title": "仓库总览", "ov.projects": "项目", "ov.repos": "仓库", "ov.images": "镜像",
      "ov.recent": "最近新建的项目", "ov.topPulled": "拉取最多的项目",
      "ov.namespaces": "命名空间", "ov.sizeByProject": "项目存储分布", "ov.sizeByNamespace": "命名空间存储分布",
      "ov.size": "总空间", "ov.pulls": "拉取次数", "ov.days": "近 {n} 天",
      "ov.truncated": "拉取日志超过读取上限，此处为已读范围内的次数（下限）。",
      "ov.errors": "部分项目读取失败（已跳过）",
      "logs.title": "操作日志", "logs.scope": "范围", "logs.scopeAll": "全局",
      "logs.operation": "操作类型", "logs.all": "全部", "logs.empty": "暂无日志",
      "logs.time": "时间", "logs.op": "操作", "logs.resource": "资源", "logs.user": "用户",
      "logs.prev": "上一页", "logs.next": "下一页", "logs.loadFailed": "读取日志失败",
      "np.title": "新建项目", "np.name": "项目名称",
      "np.nameHint": "小写字母、数字与 . _ - 组成，以字母或数字开头。",
      "np.create": "创建项目", "np.created": "项目已创建", "np.nameInvalid": "项目名称不符合规范",
      "acc.private": "私有", "acc.public": "公开",
      "project.accessLevel": "访问级别",
      "project.quota": "项目配额", "project.quotaDesc": "限制该项目可占用的存储空间。",
      "project.quotaUsed": "已用空间", "project.quotaHard": "存储上限（GB）",
      "project.quotaHard.help": "-1 表示不设限",
      "project.quotaUnlimited": "不设限", "project.quotaSaved": "配额已更新",
      "project.quotaFailed": "读取配额失败",
      "project.scanner": "漏洞扫描（本项目）",
      "settings.scanner.descProject": "按项目配置：阈值与缓存决定该项目漏洞面板的判定与复用；Harbor 侧策略需显式写入。",
      "settings.saveProject": "保存项目扫描设置", "settings.projectSaved": "项目扫描设置已保存",
      "settings.about": "关于 IMREPO", "settings.version": "版本", "settings.pluginId": "插件 ID",
      "settings.protocol": "后端协议", "settings.github": "GitHub 页面", "settings.githubSoon": "待补充",
      "settings.settingsPath": "设置文件", "settings.copy": "复制",
      "settings.noProject": "未选择项目，Harbor 侧的扫描设置不可用。",
      "settings.notHarbor": "通用 OCI v2 没有扫描接口，Harbor 侧的设置不可用。",
      "settings.loadFailed": "读取 Harbor 扫描配置失败",
      "retention.outOfPolicy": "超出保留策略", "protected.tag": "受保护 Tag",
      "protected.refused": "该 Tag 受保留策略保护，无法删除（可在设置 → 保留策略中修改）",
      "cleanup.status": "状态", "cleanup.eligible": "可清理", "cleanup.protected": "受保护",
      "cleanup.byRules": "按当前清理规则", "cleanup.protectedReason": "受规则保护",
      "cleanup.ruleKeep": "保留最近", "cleanup.ruleKeepUnit": "个", "cleanup.ruleMinAge": "最小年龄",
      "cleanup.ruleDays": "天", "cleanup.ruleExclude": "排除",
      "vuln.threshold": "阈值", "vuln.exceeds": "已达阈值", "vuln.within": "未达阈值",
      "vuln.cached": "缓存结果", "vuln.disabled": "漏洞扫描已在设置中关闭",
      "vuln.rescan": "触发扫描", "vuln.refresh": "刷新报告", "vuln.requested": "已请求扫描，Harbor 异步执行，稍后刷新报告",
      "vuln.scanner": "扫描器",
    },
    en: {
      refresh: "Refresh", explorer: "Explorer", search: "Search repos / projects...",
      "empty.title": "Connect a registry to start browsing",
      "empty.sub": "Select a project or repository on the left to view tags, layers and vulnerability reports",
      retag: "Rename tag", delete: "Delete", layers: "Layers", vuln: "Vulns", pull: "Pull",
      cancel: "Cancel", close: "Close", "retag.title": "Rename tag (retag)",
      "retag.repo": "Repository", "retag.source": "Current tag", "retag.target": "New tag",
      "retag.deleteSource": "Also delete the current tag (complete the rename)",
      "retag.ociNotice": "Plain OCI v2 registry: only the new tag can be added, remove the old tag manually.",
      "retag.hint": "Layers are not re-uploaded; the manifest is written back under the new tag.",
      "retag.targetInvalid": "A tag may contain letters, digits, '_', '.' and '-', and cannot start with '.' or '-'",
      "retag.targetSame": "The new tag is identical to the current tag",
      "retag.renamed": "Tag renamed", "retag.copied": "New tag added (old tag kept)",
      "retag.confirm": "Rename",
      "delete.title": "Confirm deletion", "delete.hint": "Soft delete (unbinds the tag); run GC on the registry to reclaim space.",
      "delete.confirm": "Delete",
      "layers.title": "Image Layers", "vuln.title": "Vulnerability Report (CVE)",
      loading: "Loading...", noData: "No data", copied: "Copied to clipboard",
      copyFailed: "Copy failed", done: "Done", failed: "Failed",
      copy: "Copy", "copy.done": "Copied",
      "pull.title": "Pull commands", "pull.sub": "Pick the command to copy to the clipboard.",
      "pull.image": "Image reference", "pull.login": "Registry login",
      cleanup: "Clean untagged", "cleanup.title": "Clean untagged artifacts",
      "cleanup.repository": "Repository",
      "cleanup.sub": "No tag points at these artifacts — they are reachable by digest only, so removing them leaves every tag intact. It is a soft delete: run GC on the registry to reclaim space.",
      "cleanup.project": "Project", "cleanup.scanned": "Repositories scanned", "cleanup.found": "Untagged artifacts",
      "cleanup.reclaim": "Reclaimable", "cleanup.none": "No untagged artifacts found.",
      "cleanup.truncated": "More repositories than the scan limit; only the first 100 were scanned.",
      "cleanup.repoErrors": "Some repositories could not be read (skipped)",
      "cleanup.selectAll": "Select all", "cleanup.confirm": "Delete selected", "cleanup.working": "Deleting...",
      "cleanup.deleted": "Deleted", "cleanup.reclaimed": "reclaimed", "cleanup.skipped": "skipped",
      "cleanup.failedCount": "failed", "cleanup.nothingSelected": "Select at least one row",
      "cleanup.needProject": "Select a project in the sidebar first",
      "cleanup.needHarbor": "Only Harbor can delete artifacts by digest; a plain OCI v2 registry cannot enumerate untagged manifests",
      repo: "Repository", tag: "Tag", size: "Size", arch: "Arch/OS", pushed: "Pushed",
      pullCount: "Pull count", tags: "Tags", updated: "Updated", public: "Public",
      untagged: "Untagged artifacts (cleanup)", noVuln: "No vulnerabilities found or scanning disabled", severity: "Severity",
      layersTotal: "Total size", layersCount: "Layers", layersPlatform: "Platform", digest: "Digest",
      layersBiggest: "Largest layer", layersBiggestTag: "largest", layersOfTotal: "of total",
      layersSort: "Order", layersByOrder: "As built", layersBySize: "By size",
      layersNoCommand: "(no command)",
      layersNone: "This manifest has no layers (an index, Helm chart or attestation)",
      imagesCount: "Images", imagesSize: "Total size", imagesRepos: "Repositories", imagesTags: "Tags",
      imagesOpenRepo: "Click to open this repository's tags",
      arch: "Architecture",
      imagesActions: "Actions", imagesTruncated: "Repository count exceeds the scan limit; only the first 100 repositories are shown.",
      imagesErrors: "Some repositories could not be read (skipped)",
      "project.settings": "Project settings", "project.members": "Members", "project.memberAdd": "Add member",
      "project.memberUser": "User", "project.memberRole": "Role", "project.memberEmpty": "No members",
      "project.retention": "Retention policy", "project.retentionNone": "No retention policy configured",
      "project.retentionHint": "The existing policy is read first; saving writes back the full policy.",
      "project.retentionKeep": "Keep the latest N tags", "project.retentionDays": "Keep tags pushed within N days",
      "project.retentionCron": "Schedule (cron)", "project.retentionSave": "Save retention policy",
      "project.retentionSaved": "Retention policy saved", "project.public": "Public project", "project.publicDesc": "A public project is readable by anyone; a private one requires authentication.",
      "project.publicLabel": "Public", "project.publicSaved": "Project visibility updated",
      "project.loadFailed": "Could not read project settings", "project.onlyHarbor": "Project permissions and retention need Harbor",
      "user.manage": "User management", "user.username": "Username", "user.email": "Email",
      "user.realname": "Real name", "user.password": "Password", "user.newPassword": "New password",
      "user.admin": "Admin", "user.create": "Create user", "user.created": "User created",
      "user.delete": "Delete", "user.deleteConfirm": "Delete this user? This cannot be undone.",
      "user.passwordSet": "Password changed", "user.none": "No users", "user.comment": "Comment",
      "user.setPwd": "Set password",
      "user.setAdmin": "Set administrator", "user.readonlyHint": "This account is not a system administrator — showing your own profile only.",
      "role.1": "Project Admin", "role.2": "Developer", "role.3": "Guest", "role.4": "Maintainer", "role.5": "Limited Guest",

      settings: "Settings", "settings.title": "Settings",
      "settings.save": "Save settings", "settings.reset": "Restore defaults", "settings.resetArm": "Click again to restore",
      "settings.saved": "Settings saved", "settings.scope": "Stored per connection; only affects this registry.",
      "settings.stored": "Stored in", "settings.defaults": "Running on defaults",
      "settings.noConnection": "No active connection: these values go to the \"default\" profile — re-check them once connected.",
      "settings.dirty": "Unsaved changes",
      "settings.cleanup": "Cleanup rules", "settings.cleanup.desc": "Decides what Clean untagged may propose; rows a rule protects cannot be picked in that dialog.",
      "settings.keepUntagged": "Keep the newest N untagged artifacts per repository", "settings.keepUntagged.help": "0 = keep none, everything is eligible",
      "settings.minAgeDays": "Only clean artifacts older than N days", "settings.minAgeDays.help": "0 = no age gate",
      "settings.excludeRepos": "Repositories that are never cleaned", "settings.excludeRepos.help": "One per line, * wildcards allowed, e.g. libs/* or internal-*",
      "settings.maxReposPerScan": "Repositories scanned per run", "settings.maxReposPerScan.help": "1-500; keeps a big project from becoming an unbounded sweep",
      "settings.retention": "Retention", "settings.retention.desc": "A protected tag cannot be deleted, and cannot be dropped by a rename either; the backend enforces this.",
      "settings.keepTagged": "Keep the newest N artifacts per repository", "settings.keepTagged.help": "0 = no marking. Advisory only — never deletes anything.",
      "settings.protectTags": "Protected tags", "settings.protectTags.help": "One per line, * wildcards allowed, e.g. latest or release-*",
      "settings.enforced": "enforced",
      "settings.scanner": "Image scanner", "settings.scanner.desc": "Findings come from Harbor's scanner; the threshold and cache here decide how the panel judges and reuses them.",
      "settings.scannerSource": "Report source", "settings.scannerSource.harbor": "Harbor built-in scanner", "settings.scannerSource.off": "Hide the vulnerability panel",
      "settings.threshold": "Severity that needs attention", "settings.sev.critical": "Critical", "settings.sev.high": "High", "settings.sev.medium": "Medium", "settings.sev.low": "Low",
      "settings.cacheSeconds": "Report cache (seconds)", "settings.cacheSeconds.help": "0 = refetch every time",
      "settings.live": "Harbor, as configured now", "settings.scanners": "Available scanners", "settings.projectScanner": "Project scanner",
      "settings.projectScanner.follow": "Follow the system default", "settings.autoScan": "Scan on push",
      "settings.preventVul": "Block pulling images with severe findings", "settings.severityOnHarbor": "Also write the severity threshold to Harbor",
      "settings.apply": "Apply to Harbor", "settings.applyArm": "Click again to write", "settings.applyHint": "Will write to Harbor project {project}: {items}",
      "settings.applyNothing": "nothing to write", "settings.applied": "Written to Harbor", "settings.notes": "Notes",

      "stab.projects": "Projects", "stab.overview": "Overview",
      overview: "Overview", logs: "Logs", newProject: "New project",
      "ov.title": "Registry overview", "ov.projects": "Projects", "ov.repos": "Repositories", "ov.images": "Images",
      "ov.recent": "Recently created projects", "ov.topPulled": "Most-pulled projects",
      "ov.namespaces": "Namespaces", "ov.sizeByProject": "Storage by project", "ov.sizeByNamespace": "Storage by namespace",
      "ov.size": "Total size", "ov.pulls": "Pulls", "ov.days": "Last {n} days",
      "ov.truncated": "The pull history exceeds the read limit; the number shown is a floor.",
      "ov.errors": "Some projects could not be read (skipped)",
      "logs.title": "Audit logs", "logs.scope": "Scope", "logs.scopeAll": "Entire registry",
      "logs.operation": "Operation", "logs.all": "All", "logs.empty": "No log entries",
      "logs.time": "Time", "logs.op": "Operation", "logs.resource": "Resource", "logs.user": "User",
      "logs.prev": "Previous", "logs.next": "Next", "logs.loadFailed": "Could not read the logs",
      "np.title": "New project", "np.name": "Project name",
      "np.nameHint": "Lowercase letters, digits, '.', '_' and '-'; must start with a letter or digit.",
      "np.create": "Create project", "np.created": "Project created", "np.nameInvalid": "The project name is not valid",
      "acc.private": "Private", "acc.public": "Public",
      "project.accessLevel": "Access level",
      "project.quota": "Storage quota", "project.quotaDesc": "Caps the storage this project may occupy.",
      "project.quotaUsed": "Used", "project.quotaHard": "Storage limit (GB)",
      "project.quotaHard.help": "-1 = no limit",
      "project.quotaUnlimited": "No limit", "project.quotaSaved": "Quota updated",
      "project.quotaFailed": "Could not read the quota",
      "project.scanner": "Vulnerability scanning (this project)",
      "settings.scanner.descProject": "Configured per project: the threshold and cache decide how this project's CVE panel judges and reuses reports; Harbor-side policy is written explicitly.",
      "settings.saveProject": "Save project scanner settings", "settings.projectSaved": "Project scanner settings saved",
      "settings.about": "About IMREPO", "settings.version": "Version", "settings.pluginId": "Plugin ID",
      "settings.protocol": "Backend protocol", "settings.github": "GitHub", "settings.githubSoon": "coming soon",
      "settings.settingsPath": "Settings file", "settings.copy": "Copy",
      "settings.noProject": "No project selected — the Harbor-side scanner settings are unavailable.",
      "settings.notHarbor": "Plain OCI v2 has no scan API, so the Harbor-side settings are unavailable.",
      "settings.loadFailed": "Could not read the Harbor scan configuration",
      "retention.outOfPolicy": "Outside retention", "protected.tag": "Protected tag",
      "protected.refused": "This tag is protected by the retention policy and cannot be deleted (change it in Settings → Retention)",
      "cleanup.status": "Status", "cleanup.eligible": "Eligible", "cleanup.protected": "Protected",
      "cleanup.byRules": "current cleanup rules", "cleanup.protectedReason": "protected by a rule",
      "cleanup.ruleKeep": "keep newest", "cleanup.ruleKeepUnit": "", "cleanup.ruleMinAge": "min age",
      "cleanup.ruleDays": "days", "cleanup.ruleExclude": "exclude",
      "vuln.threshold": "Threshold", "vuln.exceeds": "at or above threshold", "vuln.within": "below threshold",
      "vuln.cached": "cached", "vuln.disabled": "Vulnerability scanning is turned off in Settings",
      "vuln.rescan": "Trigger scan", "vuln.refresh": "Refresh report", "vuln.requested": "Scan requested; Harbor runs it asynchronously — refresh in a moment",
      "vuln.scanner": "Scanner",
    },
  };

  let locale = "zh-CN";
  function t(key) {
    const d = I18N[locale] || I18N["zh-CN"];
    return d[key] || I18N["zh-CN"][key] || key;
  }
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
  }

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) {
      if (typeof text === "string" || typeof text === "number") e.textContent = text;
      else if (text.nodeType) e.appendChild(text);
    }
    return e;
  }

  /* Inline SVG icons instead of text glyphs (◫ / 🛡 / ✕): those glyphs render as
   * thin monochrome outlines at 13px and read as "blurry" next to real text.
   * SVG inherits currentColor, so the icons stay crisp in both themes. */
  const ICONS = {
    layers: '<path d="M8 1.6 1.8 5 8 8.4 14.2 5 8 1.6Zm5.12 6.12L8 10.38 2.88 7.72 1.8 8.28 8 11.56l6.2-3.28-1.08-.56Zm0 3L8 13.38 2.88 10.72 1.8 11.28 8 14.56l6.2-3.28-1.08-.56Z"/>',
    shield: '<path d="M8 1 2.6 3.15v4.02c0 3.3 2.26 6.35 5.4 7.63 3.14-1.28 5.4-4.33 5.4-7.63V3.15L8 1Zm3.33 5.29-4.01 4.01-2.65-2.65 1.06-1.06 1.59 1.59 2.95-2.95 1.06 1.06Z"/>',
    close: '<path d="M4.28 3.22 8 6.94l3.72-3.72 1.06 1.06L9.06 8l3.72 3.72-1.06 1.06L8 9.06l-3.72 3.72-1.06-1.06L6.94 8 3.22 4.28l1.06-1.06Z"/>',
    folder: '<path d="M8 1.6 1.8 5 8 8.4 14.2 5 8 1.6Zm5.12 6.12L8 10.38 2.88 7.72 1.8 8.28 8 11.56l6.2-3.28-1.08-.56Zm0 3L8 13.38 2.88 10.72 1.8 11.28 8 14.56l6.2-3.28-1.08-.56Z"/>',
    repo: '<path d="M8 1.6 1.8 5 8 8.4 14.2 5 8 1.6Zm5.12 6.12L8 10.38 2.88 7.72 1.8 8.28 8 11.56l6.2-3.28-1.08-.56Zm0 3L8 13.38 2.88 10.72 1.8 11.28 8 14.56l6.2-3.28-1.08-.56Z"/>',
    tag: '<path d="M7.72 1.4H14v6.28l-6.32 6.32a1.4 1.4 0 0 1-1.98 0L1.4 9.7a1.4 1.4 0 0 1 0-1.98L7.72 1.4Zm3.06 2.02a1.28 1.28 0 1 0 0 2.56 1.28 1.28 0 0 0 0-2.56Z"/>',
    pull: '<path d="M7.25 1.5h1.5v6.44l2.22-2.22 1.06 1.06L8 10.81 3.97 6.78l1.06-1.06 2.22 2.22V1.5ZM2.5 12.5h11v1.5h-11v-1.5Z"/>',
    lock: '<path d="M8 1.2A3.3 3.3 0 0 0 4.7 4.5v1.6h-.5A1.2 1.2 0 0 0 3 7.3v6A1.2 1.2 0 0 0 4.2 14.5h7.6A1.2 1.2 0 0 0 13 13.3v-6a1.2 1.2 0 0 0-1.2-1.2h-.5V4.5A3.3 3.3 0 0 0 8 1.2Zm0 1.6a1.7 1.7 0 0 1 1.7 1.7v1.6H6.3V4.5A1.7 1.7 0 0 1 8 2.8Zm0 5.6a1.3 1.3 0 0 1 .7 2.4v1.5H7.3v-1.5A1.3 1.3 0 0 1 8 8.4Z"/>',
    scan: '<path d="M3 1.8h3.2v1.6H4.6v1.6H3V1.8Zm6.8 0H13v3.2h-1.6V3.4H9.8V1.8ZM4.6 11h1.6v1.6H4.6V11ZM3 9.4h1.6V11H3V9.4Zm9.4 0H13v3.2h-3.2V11h1.6V9.4ZM5.9 5.6h4.2v4.2H5.9V5.6Z"/>',
    gear: '<path d="M8 1a1.4 1.4 0 0 1 1.4 1.4l.1.6c.5.2.9.4 1.3.7l.6-.2a1.4 1.4 0 0 1 1.7.7l.6 1a1.4 1.4 0 0 1-.4 1.8l-.4.4c.1.4.1.8.1 1.2l-.1.4.4.4a1.4 1.4 0 0 1 .4 1.8l-.6 1a1.4 1.4 0 0 1-1.7.7l-.6-.2c-.4.3-.8.5-1.3.7l-.1.6A1.4 1.4 0 0 1 8 15a1.4 1.4 0 0 1-1.4-1.4l-.1-.6c-.5-.2-.9-.4-1.3-.7l-.6.2a1.4 1.4 0 0 1-1.7-.7l-.6-1a1.4 1.4 0 0 1 .4-1.8l.4-.4a5 5 0 0 1-.1-1.2l.1-.4-.4-.4a1.4 1.4 0 0 1-.4-1.8l.6-1a1.4 1.4 0 0 1 1.7-.7l.6.2c.4-.3.8-.5 1.3-.7l.1-.6A1.4 1.4 0 0 1 8 1Zm0 4.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6Z"/>',
  };
  function svgIcon(name) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.innerHTML = ICONS[name] || "";
    return s;
  }

  function fmtSize(bytes) {
    if (bytes == null) return "—";
    const n = Number(bytes) || 0;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + units[i];
  }
  function fmtTime(s) {
    if (!s) return "—";
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US", { hour12: false });
  }

  async function invoke(method, params = {}) {
    const p = { ...params };
    if (state.connectionId && !p.connectionId) p.connectionId = state.connectionId;
    return await window.dbxPlugin.invoke(method, p, { timeoutMs: 90000 });
  }

  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(el._t);
    // Warnings and errors carry detail the user has to read (and often copy).
    el._t = setTimeout(() => (el.hidden = true), kind === "warn" || kind === "err" ? 7000 : 2600);
  }

  function loadingHTML() {
    return `<div class="loading"><span class="spinner"></span>${t("loading")}</div>`;
  }

  /* ---------- cached, deduplicated loading ---------- */
  function cacheKey(kind, project, repo) {
    return [kind, state.mode, project || "", repo || ""].join("|");
  }

  function setLoading(key, on) {
    if (!key) return;
    if (on) state.loadingKeys.add(key);
    else state.loadingKeys.delete(key);
    syncRowSpinners();
  }

  /** Paints/clears the little spinner on every sidebar row that is being fetched. */
  function syncRowSpinners() {
    document.querySelectorAll(".tree-item[data-key]").forEach((node) => {
      const spin = node.querySelector(".row-spinner");
      if (spin) spin.hidden = !state.loadingKeys.has(node.dataset.key);
    });
  }

  function invalidate(key) {
    if (key) state.cache.delete(key);
    else state.cache.clear();
  }

  /**
   * Fetches through the cache. Concurrent calls for the same repository share one
   * request, which matters because a click can land while a prefetch is running.
   */
  function fetchCached(kind, project, repo, method, params) {
    const key = cacheKey(kind, project, repo);
    const hit = state.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.data);
    if (state.inflight.has(key)) return state.inflight.get(key);

    setLoading(key, true);
    const p = invoke(method, params)
      .then((data) => {
        state.cache.set(key, { data, at: Date.now() });
        return data;
      })
      .finally(() => {
        state.inflight.delete(key);
        setLoading(key, false);
      });
    state.inflight.set(key, p);
    return p;
  }

  const fetchArtifacts = (project, repo) =>
    fetchCached("artifacts", project, repo, "harbor/artifacts", { project, repository: repo });

  const fetchTags = (repo) =>
    fetchCached("tags", null, repo, "registry/tags", { repository: repo });

  function currentKey() {
    if (!state.current.repo) return null;
    return state.mode === "harbor"
      ? cacheKey("artifacts", state.current.project, shortRepo())
      : cacheKey("tags", null, state.current.repo);
  }

  /**
   * Warms repository listings in the background so a click is instant instead of
   * a multi-second wait. Runs strictly one at a time — the goal is to remove the
   * wait, not to hammer the registry with a burst of parallel scans.
   */
  function schedulePrefetch(jobs) {
    const wanted = jobs.slice(0, PREFETCH_LIMIT).filter((j) => {
      const key = cacheKey(j.kind, j.project, j.repo);
      const hit = state.cache.get(key);
      return !(hit && Date.now() - hit.at < CACHE_TTL_MS);
    });
    // Newest project wins: drop whatever was queued for a project you left.
    state.prefetchQueue = wanted;
    if (!state.prefetching) runPrefetch();
  }

  async function runPrefetch() {
    state.prefetching = true;
    try {
      while (state.prefetchQueue.length) {
        const job = state.prefetchQueue.shift();
        try {
          if (job.kind === "artifacts") await fetchArtifacts(job.project, job.repo);
          else await fetchTags(job.repo);
        } catch (_) {
          /* Prefetch failures stay silent — clicking the row reports them. */
        }
      }
    } finally {
      state.prefetching = false;
    }
  }

  /* ---------- bootstrap ---------- */
  async function init() {
    if (window.dbxPlugin && window.dbxPlugin.ready) {
      try { await window.dbxPlugin.ready; } catch (_) {}
    }
    if (window.dbxPlugin && window.dbxPlugin.locale) locale = window.dbxPlugin.locale;
    if (locale.startsWith("en")) locale = "en"; else locale = "zh-CN";

    applyTheme();
    applyI18n();
    setupUI();

    const ctx = (window.dbxPlugin && window.dbxPlugin.context) || {};
    state.connectionId = ctx.connectionId || (ctx.connection && ctx.connection.id) || ctx.id || null;
    if (ctx.connection) {
      state.connInfo.name = ctx.connection.name || "";
      state.connInfo.endpoint = ctx.connection.host || "";
    }
    if (window.dbxPlugin && window.dbxPlugin.onContext) {
      window.dbxPlugin.onContext((next) => {
        if (!next) return;
        const id = next.connectionId || (next.connection && next.connection.id);
        if (id && id !== state.connectionId) {
          // Switched to another registry: nothing cached may be reused, and any
          // response still in flight belongs to the old one.
          invalidate();
          state.prefetchQueue = [];
          state.viewSeq++;
        }
        state.connectionId = id || state.connectionId;
      });
    }
    window.addEventListener("dbx-plugin-env", () => { applyTheme(); });

    // Best-effort: retention markers and the cleanup dialog read these, so one
    // quiet read at startup beats a wrong first impression. Failures are
    // surfaced in the settings dialog instead of blocking the workbench.
    await preloadSettings();

    await bootstrap();
  }

  function applyTheme() {
    // The host publishes the appearance via data-dbx-theme AND window.dbxPlugin.theme.
    // Trust whichever is present; only fall back to the OS preference when both are
    // missing — defaulting blindly to "dark" painted a dark UI in a light host.
    const attr = document.documentElement.getAttribute("data-dbx-theme");
    const bridge = window.dbxPlugin && window.dbxPlugin.theme && window.dbxPlugin.theme.appearance;
    const known = (v) => v === "light" || v === "dark";
    const theme = (known(bridge) && bridge) || (known(attr) && attr)
      || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-dbx-theme", theme);
  }

  async function bootstrap() {
    try {
      const info = await invoke("registry/info");
      if (info) {
        state.connInfo.type = info.registryType || "";
        state.connInfo.endpoint = info.endpoint || state.connInfo.endpoint;
        state.connInfo.name = info.name || state.connInfo.name;
        renderConnInfo();
      }
    } catch (_) { /* no active connection */ }

    // Detect Harbor vs standard registry.
    try {
      const projects = await invoke("harbor/projects");
      if (Array.isArray(projects)) {
        state.mode = "harbor";
        state.projects = projects;
        renderSidebar();
        return;
      }
    } catch (_) {}
    state.mode = "docker-v2";
    await loadNamespaces();
  }

  function renderConnInfo() {
    $(".conn-name").textContent = state.connInfo.name || "—";
    $(".conn-endpoint").textContent = state.connInfo.endpoint || "";
    const badge = $("#connType");
    badge.textContent = state.connInfo.type || "registry";
  }

  /* ---------- sidebar ---------- */
  function renderSidebar() {
    // Tab chrome: which tab is active, which panels are visible.
    document.querySelectorAll("#sidebarTabs .stab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === state.sidebarTab);
    });
    const isOverview = state.sidebarTab === "overview";
    $("#sidebarSearch").hidden = isOverview;
    $("#treeTitle").hidden = isOverview;
    $("#tree").hidden = isOverview;
    $("#overviewList").hidden = !isOverview;

    if (isOverview) {
      renderOverviewList();
      return;
    }
    renderTree();
  }

  /** The project tree (resources tab). */
  function renderTree() {
    const tree = $("#tree");
    tree.innerHTML = "";
    const q = state.search.trim().toLowerCase();

    // Both modes browse a folder-first project tree. Harbor projects come from
    // its REST API; for a plain v2 registry the projects are repository-name
    // namespaces (first path segment), loaded by loadNamespaces().
    const projects = state.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    if (!projects.length) { tree.appendChild(el("div", "muted", t("noData"))); return; }
    for (const p of projects) {
      const item = treeItem("project", "folder", p.name, p.repo_count ? String(p.repo_count) : "");
      item.addEventListener("click", () => selectProject(p));
      // Per-folder settings entry: a gear on the project row, Harbor only.
      if (state.mode === "harbor") {
        const gear = el("span", "tree-settings");
        gear.title = t("project.settings");
        gear.appendChild(svgIcon("gear"));
        gear.addEventListener("click", (e) => { e.stopPropagation(); openProjectSettings(p.name); });
        item.appendChild(gear);
      }
      tree.appendChild(item);
      if (state.expandedProject === p.name && state.reposLoading && !state.repos.length) {
        const wait = el("div", "tree-loading");
        wait.appendChild(el("span", "spinner"));
        wait.appendChild(el("span", "", t("loading")));
        tree.appendChild(wait);
      }
      if (state.expandedProject === p.name) {
        for (const r of state.repos) {
          const key = state.mode === "harbor"
            ? cacheKey("artifacts", p.name, r.name)
            : cacheKey("tags", null, r.full_name);
          const ri = treeItem("repo", "repo", r.name, r.artifact_count ? String(r.artifact_count) : "", "lvl2", key);
          ri.addEventListener("click", () => selectRepo(p, r));
          if (state.current.repo === r.full_name) ri.classList.add("active");
          tree.appendChild(ri);
        }
      }
      if (state.current.project === p.name && state.current.repo == null) item.classList.add("active");
    }
    // Re-apply spinners: the tree was just rebuilt.
    syncRowSpinners();
    syncCleanupButton();   // cleanup needs Harbor + a selected project
  }

  /**
   * @param key  cache key for this row, so an in-flight fetch can show a spinner
   *             on the exact row it belongs to (click or background prefetch).
   */
  function treeItem(kind, icon, label, meta, extraCls, key) {
    const item = el("div", "tree-item" + (extraCls ? " " + extraCls : ""));
    if (key) item.dataset.key = key;
    const ic = el("span", "ic");
    ic.appendChild(svgIcon(icon || (kind === "project" ? "folder" : "repo")));
    item.appendChild(ic);
    item.appendChild(el("span", "label", label));

    const right = el("div", "right");
    const spin = el("span", "row-spinner");
    spin.appendChild(el("span", "spinner"));
    spin.hidden = true;
    right.appendChild(spin);
    if (meta) right.appendChild(el("span", "meta", meta));
    item.appendChild(right);
    return item;
  }

  async function loadCatalog() {
    $("#tree").innerHTML = loadingHTML();
    try {
      state.repos = await fetchCached("catalog", null, "", "registry/catalog", {});
      schedulePrefetch(state.repos.map((r) => ({ kind: "tags", repo: r })));
    } catch (e) {
      state.repos = [];
      toast(e.message || t("failed"), "err");
    }
    renderSidebar();
  }

  /**
   * For a plain Docker Registry v2 there is no project API — repositories are
   * grouped by their first path segment into namespaces, which the tree shows as
   * folders (exactly like Harbor projects).
   */
  async function loadNamespaces() {
    $("#tree").innerHTML = loadingHTML();
    try {
      state.projects = await invoke("registry/namespaces", {});
      state.repos = [];
    } catch (e) {
      state.projects = [];
      toast(e.message || t("failed"), "err");
    }
    renderSidebar();
  }

  async function selectProject(p) {
    if (state.expandedProject === p.name) { state.expandedProject = null; state.repos = []; renderSidebar(); return; }
    await goToProject(p.name);
  }

  /**
   * Expands a project and shows its image overview. Shared by the sidebar click
   * and the breadcrumb: clicking the project segment of a "project / repo"
   * trail is exactly "open this project" again.
   */
  async function goToProject(name) {
    const p = state.projects.find((x) => x.name === name) || { name };
    state.expandedProject = p.name;
    state.current.project = p.name;
    state.current.repo = null;
    state.repos = [];
    state.reposLoading = true;
    setCrumbs([{ name: p.name }]);
    renderSidebar();
    if (state.mode === "harbor") {
      // The project is a "folder": selecting it shows every image across the
      // project's repositories at once (image-first, no tag column), not an empty
      // pane waiting for a repository click.
      showProjectImages(p.name);
      try {
        state.repos = await fetchCached("repos", p.name, "", "harbor/repositories", { project: p.name });
        // Warm the first few repositories so clicking one is instant rather than a
        // multi-second wait. Runs one request at a time, in the background.
        schedulePrefetch(state.repos.map((r) => ({ kind: "artifacts", project: p.name, repo: r.name })));
      } catch (e) {
        toast(e.message || t("failed"), "err");
      }
    } else {
      // A v2 namespace acts as the project: overview lists its repos/images.
      showV2ProjectOverview(p.name);
      try {
        state.repos = await fetchCached("repos", p.name, "", "registry/repositories", { namespace: p.name });
        schedulePrefetch(state.repos.map((r) => ({ kind: "tags", repo: r.full_name })));
      } catch (e) {
        toast(e.message || t("failed"), "err");
      }
    }
    state.reposLoading = false;
    renderSidebar();
  }

  /** Loads the project-level image overview into the content pane. */
  async function showProjectImages(project) {
    const seq = ++state.viewSeq;
    const body = $("#contentBody");
    body.innerHTML = loadingHTML();
    try {
      const data = await fetchCached("images", project, "", "harbor/images", { project });
      if (seq !== state.viewSeq) return;   // a newer selection won
      state.projectImages = data;
      renderImagesOverview(project, data);
    } catch (e) {
      if (seq !== state.viewSeq) return;
      body.innerHTML = "";
      showError(e);
    }
  }

  /**
   * Project-level image overview: totals up top, then one row per image (digest).
   * Deliberately image-first — there is no tag column; tags only feed the pull /
   * layers / vuln actions and the "Tag 数" total.
   */
  function renderImagesOverview(project, data) {
    const body = $("#contentBody");
    body.innerHTML = "";
    const images = (data && data.images) || [];

    const stats = el("div", "img-stats");
    const stat = (label, value, strong) => {
      const c = el("div", "img-stat");
      c.appendChild(el("span", "k", label));
      c.appendChild(el("span", "v" + (strong ? " strong" : ""), value));
      stats.appendChild(c);
    };
    stat(t("imagesCount"), String(data.imageCount || 0), true);
    stat(t("imagesSize"), fmtSize(data.totalSize || 0), true);
    stat(t("imagesRepos"), String(data.repositoryCount || 0));
    stat(t("imagesTags"), String(data.tagCount || 0));
    body.appendChild(stats);

    if (data.truncated) body.appendChild(el("p", "hint warn", t("imagesTruncated")));
    if ((data.repositoryErrors || []).length) {
      body.appendChild(el("p", "hint warn", t("imagesErrors") + " (" + data.repositoryErrors.length + ")"));
    }

    if (!images.length) {
      body.appendChild(el("div", "empty-state", el("p", "", t("noData"))));
      return;
    }

    const table = el("table", "table");
    const thead = el("thead");
    const hr = el("tr");
    [t("repo"), t("digest"), t("size"), t("pushed"), t("imagesTags"), t("imagesActions")].forEach((h) => hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const im of images) {
      const ref = (im.tags && im.tags[0]) || im.digest;
      const tr = el("tr");
      // The repository name is a way in: clicking it opens that repository's
      // own listing with the full tag view.
      const tdRepo = el("td");
      const link = el("a", "repo-link", im.repository);
      link.href = "#";
      link.title = t("imagesOpenRepo");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        selectRepo({ name: project }, { name: im.repository, full_name: project + "/" + im.repository });
      });
      tdRepo.appendChild(link);
      tr.appendChild(tdRepo);
      const tdDigest = el("td");
      const dg = el("span", "mono digest-cell", shortDigest(im.digest));
      dg.title = im.digest || "";
      tdDigest.appendChild(dg);
      if (im.type && im.type !== "IMAGE") tdDigest.appendChild(el("span", "badge soft", im.type));
      tdDigest.appendChild(archBadges(im.arches));
      tr.appendChild(tdDigest);
      tr.appendChild(el("td", "", fmtSize(im.size)));
      tr.appendChild(el("td", "", fmtTime(im.push_time)));
      tr.appendChild(el("td", "num", String(im.tagCount || 0)));
      const tdActs = el("td");
      const acts = el("div", "actions");
      // Rename replaces pull/layers here: an overview row answers "what is
      // here and how old", not "how do I run this image" — the repository
      // view has the full action set.
      if ((im.tags || []).length) {
        acts.appendChild(iconBtn(t("retag"), "tag", () => openRetag(project + "/" + im.repository, im.tags, im.tags[0])));
      }
      acts.appendChild(iconBtn(t("vuln"), "shield", () => openVuln(project + "/" + im.repository, ref, im.digest)));
      tdActs.appendChild(acts);
      tr.appendChild(tdActs);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /** Loads a v2 namespace's overview into the content pane. */
  async function showV2ProjectOverview(namespace) {
    const seq = ++state.viewSeq;
    const body = $("#contentBody");
    body.innerHTML = loadingHTML();
    try {
      const data = await fetchCached("v2images", namespace, "", "registry/images", { namespace });
      if (seq !== state.viewSeq) return;
      renderV2ProjectOverview(namespace, data);
    } catch (e) {
      if (seq !== state.viewSeq) return;
      body.innerHTML = "";
      showError(e);
    }
  }

  /**
   * Namespace-level overview for a v2 registry: totals up top, then one row per
   * repository (image count, tag count, summed size). Clicking a repository opens
   * its tag listing.
   */
  function renderV2ProjectOverview(namespace, data) {
    const body = $("#contentBody");
    body.innerHTML = "";
    const repos = (data && data.repos) || [];

    const stats = el("div", "img-stats");
    const stat = (label, value, strong) => {
      const c = el("div", "img-stat");
      c.appendChild(el("span", "k", label));
      c.appendChild(el("span", "v" + (strong ? " strong" : ""), value));
      stats.appendChild(c);
    };
    stat(t("imagesCount"), String(data.imageCount || 0), true);
    stat(t("imagesSize"), fmtSize(data.totalSize || 0), true);
    stat(t("imagesRepos"), String(data.repoCount || 0));
    stat(t("imagesTags"), String(data.tagCount || 0));
    body.appendChild(stats);

    if (data.truncated) body.appendChild(el("p", "hint warn", t("imagesTruncated")));
    if ((data.errors || []).length) {
      body.appendChild(el("p", "hint warn", t("imagesErrors") + " (" + data.errors.length + ")"));
    }
    if (!repos.length) {
      body.appendChild(el("div", "empty-state", el("p", "", t("noData"))));
      return;
    }

    const table = el("table", "table");
    const thead = el("thead");
    const hr = el("tr");
    [t("repo"), t("imagesCount"), t("imagesTags"), t("size")].forEach((h) => hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const r of repos) {
      const tr = el("tr");
      const tdRepo = el("td");
      const link = el("a", "repo-link", r.name);
      link.href = "#";
      link.title = t("imagesOpenRepo");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        selectRepo({ name: namespace }, { name: r.name, full_name: r.full_name || namespace + "/" + r.name });
      });
      tdRepo.appendChild(link);
      tr.appendChild(tdRepo);
      tr.appendChild(el("td", "num", String(r.imageCount || 0)));
      tr.appendChild(el("td", "num", String(r.tagCount || 0)));
      tr.appendChild(el("td", "", fmtSize(r.size)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  async function selectRepo(project, repo) {
    state.current.project = project ? project.name : null;
    state.current.repo = repo.full_name;
    setCrumbs(project ? [
      { name: project.name, onClick: () => goToProject(project.name) },
      { name: repo.name },
    ] : [{ name: repo.name }]);
    renderSidebar();                                   // highlight + spinner slot
    // Harbor passes the repo name within its project; a v2 registry needs the
    // full namespaced path for the /v2/ endpoints.
    await showRepo(project ? project.name : null,
      state.mode === "harbor" ? repo.name : repo.full_name);
  }

  /**
   * Loads the artifacts/tags of one repository into the content pane.
   *
   * The sequence check is the important part: a large repository can answer long
   * after you have clicked another one, and without this guard its late response
   * would paint over the newer view — two repositories' contents ending up under
   * the name of the one clicked last.
   */
  async function showRepo(project, repo) {
    const seq = ++state.viewSeq;
    const body = $("#contentBody");
    body.innerHTML = loadingHTML();

    try {
      if (state.mode === "harbor") {
        const data = await fetchArtifacts(project, repo);
        if (seq !== state.viewSeq) return;             // a newer selection won
        state.artifacts = data;
        renderArtifactsTable(project, repo);
      } else {
        const data = await fetchTags(repo);
        if (seq !== state.viewSeq) return;
        state.tags = data;
        renderTagsTable(repo);
      }
    } catch (e) {
      if (seq !== state.viewSeq) return;
      body.innerHTML = "";
      showError(e);
    }
  }

  function showError(e) {
    const d = el("div", "empty-state");
    d.appendChild(el("p", "", e.message || t("failed")));
    $("#contentBody").appendChild(d);
  }

  /**
   * Renders the breadcrumb. Parts carry an optional onClick: a clickable segment
   * navigates back to that level. Deliberately NOT styled as a blue link — the
   * color stays exactly like the static text, an underline is the only affordance.
   */
  function setCrumbs(parts) {
    const c = $("#crumbs");
    c.innerHTML = "";
    parts.forEach((p, i) => {
      if (i > 0) c.appendChild(el("span", "sep", "/"));
      if (p.onClick) {
        const a = el("a", "crumb-link", p.name);
        a.href = "#";
        a.title = p.name;
        a.addEventListener("click", (e) => { e.preventDefault(); p.onClick(); });
        c.appendChild(a);
      } else {
        const span = el("span", i === parts.length - 1 ? "current" : "", p.name);
        c.appendChild(span);
      }
    });
  }

  /** A tag chip; a lock means the retention policy refuses to remove it. */
  function tagChip(name) {
    const chip = el("span", "tag-chip mono", name);
    const pat = protectedPattern(name);
    if (pat) {
      chip.classList.add("protected");
      chip.title = t("protected.tag") + ": " + pat;
      chip.appendChild(svgIcon("lock"));
    }
    return chip;
  }

  /* Architecture badges: one circle per architecture (amd64 / arm64 / …). */
  function archBadge(a) {
    const b = el("span", "arch-badge mono", a);
    b.title = t("arch") + ": " + a;
    return b;
  }
  function archBadges(arches) {
    const wrap = el("span", "arch-badges");
    (arches || []).forEach((a) => wrap.appendChild(archBadge(a)));
    return wrap;
  }

  /* A v2 tag list carries no platform info, so each tag's architectures are
   * fetched lazily (one cheap manifest read) and painted into place. Cached per
   * repo|tag for the session. The slot itself is the .arch-badges container —
   * badges are dropped straight in, never nested inside another wrapper. */
  const archCache = new Map();
  async function loadTagArches(repo, tag, slot) {
    const key = repo + "|" + tag;
    let arches = archCache.get(key);
    if (!arches) {
      try {
        const r = await invoke("registry/arches", { repository: repo, reference: tag });
        arches = r.arches || [];
      } catch (_) { arches = []; }
      archCache.set(key, arches);
    }
    if (arches.length && slot.isConnected) {
      slot.innerHTML = "";
      (arches || []).forEach((a) => slot.appendChild(archBadge(a)));
    }
  }

  /**
   * Delete action for one tag. A protected tag never opens the confirmation —
   * explaining up front beats a modal that fails on submit. The backend refuses
   * too; this is only the polite half.
   */
  /**
   * Picks which tag a row's delete action acts on: the first one the retention
   * policy allows, falling back to a blocked button (which explains itself) when
   * every tag on the artifact is protected.
   */
  function deletableTag(names, fallback) {
    const open = (names || []).filter((n) => !protectedPattern(n));
    return open.length ? open[0] : fallback;
  }

  function deleteTagBtn(repo, tag, reference) {
    const pat = protectedPattern(tag);
    const b = iconBtn(
      pat ? t("protected.refused") : t("delete"),
      "close",
      () => {
        if (pat) { toast(t("protected.refused") + "  [" + pat + "]", "err"); return; }
        openDelete(repo, tag, reference);
      },
      "danger" + (pat ? " blocked" : ""),
    );
    if (pat) {
      b.classList.add("blocked");
      b.setAttribute("aria-disabled", "true");
    }
    return b;
  }

  /**
   * Which artifacts fall outside the retention window, keyed by digest.
   * Advisory only: the newest N tagged artifacts are "inside policy". Computed
   * here because the rule needs the repository listing, which only this view has.
   */
  function outOfPolicy(arts) {
    const keep = settingsOf().retention.keepTagged;
    const set = new Set();
    if (!keep) return set;
    const tagged = (arts || [])
      .filter((a) => (a.tags || []).length)
      .slice()
      .sort((a, b) => (Date.parse(b.push_time) || 0) - (Date.parse(a.push_time) || 0));
    tagged.forEach((a, i) => { if (i >= keep) set.add(a.digest); });
    return set;
  }

  function iconBtn(title, icon, onClick, extraCls) {
    const b = el("button", "icon-btn" + (extraCls ? " " + extraCls : ""));
    b.title = title;
    if (ICONS[icon]) {
      b.setAttribute("aria-label", title);
      b.appendChild(svgIcon(icon));
    } else {
      b.textContent = icon;
    }
    b.addEventListener("click", onClick);
    return b;
  }

  function renderTagsTable(repo) {
    const tags = state.tags || [];
    const body = $("#contentBody");
    body.innerHTML = "";
    if (!tags.length) { body.appendChild(el("div", "empty-state", el("p", "", t("noData")))); return; }

    const table = el("table", "table");
    const thead = el("thead");
    const hr = el("tr");
    [t("tag"), t("pull"), t("retag"), t("layers"), t("vuln"), t("delete")].forEach((h) => hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const tg of tags) {
      const tr = el("tr");
      const tdTag = el("td");
      tdTag.appendChild(tagChip(tg));
      const archSlot = el("span", "arch-badges");
      tdTag.appendChild(archSlot);
      loadTagArches(repo, tg, archSlot);
      const tdPull = el("td");
      const pullBtn = el("button", "btn btn-outline btn-sm copy-btn", t("pull"));
      pullBtn.title = t("pull");
      pullBtn.addEventListener("click", () => openPull(repo, tg));
      tdPull.appendChild(pullBtn);
      const tdRetag = el("td");
      tdRetag.appendChild(iconBtn(t("retag"), "tag", () => openRetag(repo, [tg], tg)));
      const tdLayers = el("td");
      tdLayers.appendChild(iconBtn(t("layers"), "layers", () => openLayers(repo, tg)));
      const tdVuln = el("td");
      tdVuln.appendChild(iconBtn(t("vuln"), "shield", () => openVuln(repo, tg, null)));
      const tdDel = el("td");
      tdDel.appendChild(deleteTagBtn(repo, tg, null));
      tr.append(tdTag, tdPull, tdRetag, tdLayers, tdVuln, tdDel);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  function renderArtifactsTable(project, repo) {
    const arts = state.artifacts || [];
    const body = $("#contentBody");
    body.innerHTML = "";
    if (!arts.length) { body.appendChild(el("div", "empty-state", el("p", "", t("noData")))); return; }

    const outside = outOfPolicy(arts);

    const table = el("table", "table");
    const thead = el("thead");
    const hr = el("tr");
    [t("tag"), t("size"), t("pushed"), t("pull"), t("retag"), t("layers"), t("vuln"), t("delete")].forEach((h) => hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const a of arts) {
      const names = (a.tags && a.tags.length) ? a.tags.map((x) => x.name) : [];
      const tr = el("tr");
      const tdTag = el("td");
      if (names.length) names.forEach((n) => tdTag.appendChild(tagChip(n)));
      else tdTag.appendChild(el("span", "tag-chip", t("untagged")));
      tdTag.appendChild(archBadges(a.arches));
      // Only tagged images have a retention position; untagged ones belong to cleanup.
      if (names.length && outside.has(a.digest)) {
        const mark = el("span", "badge warn-soft", t("retention.outOfPolicy"));
        mark.title = t("settings.keepTagged") + ": " + settingsOf().retention.keepTagged;
        tdTag.appendChild(mark);
      }
      const tdSize = el("td", "", fmtSize(a.size));
      const tdPush = el("td", "", fmtTime(a.push_time));
      const tdPull = el("td");
      const pullBtn = el("button", "btn btn-outline btn-sm copy-btn", t("pull"));
      pullBtn.addEventListener("click", () => openPull(project + "/" + repo, names[0] || a.digest));
      tdPull.appendChild(pullBtn);
      const ref0 = names[0] || a.digest;
      const tdRetag = el("td");
      // A retag needs a tag as its source; untagged artifacts are digest-only.
      if (names.length) tdRetag.appendChild(iconBtn(t("retag"), "tag", () => openRetag(project + "/" + repo, names, names[0])));
      const tdLayers = el("td");
      tdLayers.appendChild(iconBtn(t("layers"), "layers", () => openLayers(project + "/" + repo, ref0)));
      const tdVuln = el("td");
      tdVuln.appendChild(iconBtn(t("vuln"), "shield", () => openVuln(project + "/" + repo, ref0, a.digest)));
      const tdDel = el("td");
      if (names.length) tdDel.appendChild(deleteTagBtn(project + "/" + repo, deletableTag(names, names[0]), a.digest));
      tr.append(tdTag, tdSize, tdPush, tdPull, tdRetag, tdLayers, tdVuln, tdDel);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /* ---------- pull commands ---------- */
  function registryHost() {
    const ep = (state.connInfo.endpoint || "").trim();
    return ep ? ep.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  }

  /**
   * Every command the user might paste into a terminal, as separate entries.
   * These used to be concatenated into a single clipboard write, which is
   * useless the moment you only want one of them.
   */
  function pullVariants(image, host) {
    const rows = [
      { id: "image", label: t("pull.image"), cmd: image, ref: true },
      { id: "docker", label: "Docker", cmd: "docker pull " + image },
      { id: "nerdctl", label: "containerd (nerdctl)", cmd: "nerdctl pull " + image },
      { id: "crictl", label: "crictl", cmd: "crictl pull " + image },
      { id: "podman", label: "Podman", cmd: "podman pull " + image },
      { id: "ctr", label: "ctr -n k8s.io", cmd: "ctr -n k8s.io images pull " + image },
    ];
    if (host) rows.push({ id: "login", label: t("pull.login"), cmd: "docker login " + host });
    return rows;
  }

  function openPull(repo, tag) {
    const host = registryHost();
    const image = (host ? host + "/" : "") + repo + ":" + tag;

    const body = $("#pullBody");
    body.innerHTML = "";
    body.appendChild(el("p", "hint", t("pull.sub")));

    const list = el("div", "cmd-list");
    pullVariants(image, host).forEach((v) => {
      const row = el("div", "cmd-row" + (v.ref ? " cmd-row-ref" : ""));
      const top = el("div", "cmd-row-top");
      top.appendChild(el("span", "cmd-label", v.label));

      const btn = el("button", "btn btn-outline btn-sm copy-btn", t("copy"));
      let timer = null;
      const flash = (label) => {
        btn.textContent = label;
        clearTimeout(timer);
        timer = setTimeout(() => (btn.textContent = t("copy")), 1200);
      };
      // The row itself is the hit target; the button just makes that obvious.
      row.addEventListener("click", async () => {
        flash((await copyText(v.cmd, true)) ? t("copy.done") : t("copyFailed"));
      });
      btn.addEventListener("click", (e) => { e.stopPropagation(); row.click(); });
      top.appendChild(btn);
      row.appendChild(top);
      row.appendChild(el("code", "cmd-text", v.cmd));
      list.appendChild(row);
    });
    body.appendChild(list);

    $("#pullModal").hidden = false;
  }

  /** Copies text and resolves with whether it worked (callers may want feedback). */
  function copyText(text, quiet) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => { if (!quiet) toast(t("copied"), "ok"); return true; })
        .catch(() => fallbackCopy(text, quiet));
    }
    return Promise.resolve(fallbackCopy(text, quiet));
  }
  function fallbackCopy(text, quiet) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      if (!quiet) toast(t("copied"), "ok");
      return true;
    } catch (_) {
      toast(t("copyFailed"), "err");
      return false;
    }
  }

  let pendingDelete = null;

  // Same grammar the backend enforces, checked here so the user gets an instant
  // answer instead of a registry round-trip.
  const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

  /**
   * Opens the retag dialog.
   * @param repo  repository path (project/name for Harbor)
   * @param tags  every tag currently on that artifact — an artifact can carry
   *              several, so the user has to pick which one to rename
   * @param preferred  tag to preselect
   */
  function openRetag(repo, tags, preferred) {
    const list = (tags || []).filter(Boolean);
    const sel = $("#retagSource");
    sel.innerHTML = "";
    list.forEach((tg) => {
      const opt = document.createElement("option");
      opt.value = tg;
      opt.textContent = tg;
      sel.appendChild(opt);
    });
    if (preferred && list.includes(preferred)) sel.value = preferred;
    else if (list.length) sel.value = list[0];

    $("#retagRepo").value = repo;
    $("#retagTarget").value = "";

    // Only Harbor can drop a single tag; say so up front rather than silently
    // leaving the old tag behind.
    const canDelete = state.mode === "harbor";
    const box = $("#retagDeleteSource");
    box.disabled = !canDelete;
    box.checked = canDelete;
    $("#retagNotice").hidden = canDelete;

    refreshRetagProtection();

    $("#retagModal").hidden = false;
    $("#retagTarget").focus();
  }

  /**
   * Keeps the retag dialog honest about the retention policy: the source tag may
   * gain a new tag (nothing is lost), but dropping a protected one is refused,
   * so the checkbox is disabled with a reason instead of failing on submit.
   */
  function refreshRetagProtection() {
    const box = $("#retagDeleteSource");
    const note = $("#retagProtect");
    if (!box || !note) return;
    const source = $("#retagSource").value;
    const pat = protectedPattern(source);
    if (pat) {
      box.checked = false;
      box.disabled = true;
      note.textContent = t("protected.refused") + "  [" + pat + "]";
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = "";
      box.disabled = state.mode !== "harbor";
      if (!box.disabled) box.checked = true;
    }
  }

  function openDelete(repo, tag, reference) {
    // Defence in depth: the button already refuses, and so does the backend.
    const pat = protectedPattern(tag);
    if (pat) { toast(t("protected.refused") + "  [" + pat + "]", "err"); return; }
    pendingDelete = { repo, tag, reference };
    $("#deleteMsg").textContent = `${t("retag.repo")}: ${repo}  ·  ${t("tag")}: ${tag}`;
    $("#deleteModal").hidden = false;
  }

  /* ---------- untagged artifact cleanup (PRD 2.4) ----------
   * Read-only scan → explicit list with sizes → confirmation → deletion.
   * The backend re-checks every target is still untagged right before deleting,
   * so a digest that gained a tag while the dialog was open is skipped. */
  let pendingCleanup = null;

  const shortDigest = (d) => (d && d.length > 24 ? d.slice(0, 24) + "…" : (d || "—"));

  function syncCleanupButton() {
    const btn = $("#btnCleanup");
    if (!btn) return;
    const harbor = state.mode === "harbor";
    const hasProject = !!state.current.project;
    btn.disabled = !(harbor && hasProject);
    btn.title = !harbor ? t("cleanup.needHarbor") : hasProject ? t("cleanup.title") : t("cleanup.needProject");
    // Harbor-only toolbar actions: a plain v2 registry has no project creation
    // or audit-log API, so those buttons are hidden rather than shown dead.
    const np = $("#btnNewProject");
    if (np) np.hidden = !harbor;
    const lg = $("#btnLogs");
    if (lg) lg.hidden = !harbor;
  }

  function setCleanupConfirm(count) {
    const btn = $("#btnCleanupConfirm");
    if (!btn) return;
    btn.disabled = count === 0;
    btn.textContent = count ? `${t("cleanup.confirm")} (${count})` : t("cleanup.confirm");
  }

  async function openCleanup() {
    if (state.mode !== "harbor") { toast(t("cleanup.needHarbor"), "warn"); return; }
    const project = state.current.project;
    if (!project) { toast(t("cleanup.needProject"), "warn"); return; }

    $("#cleanupModal").hidden = false;
    const body = $("#cleanupBody");
    body.innerHTML = loadingHTML();
    pendingCleanup = null;
    setCleanupConfirm(0);
    try {
      const scan = await invoke("harbor/untagged", { project });
      renderCleanup(project, scan);
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(el("p", "hint warn", e.message || t("failed")));
    }
  }

  function renderCleanup(project, scan) {
    const body = $("#cleanupBody");
    body.innerHTML = "";
    const items = (scan && scan.items) || [];

    const sum = el("div", "cleanup-summary");
    sum.appendChild(el("span", "", t("cleanup.project") + ": " + project));
    sum.appendChild(el("span", "", t("cleanup.scanned") + ": " +
      (scan.scannedRepositories || 0) + "/" + (scan.totalRepositories || 0)));
    sum.appendChild(el("span", "strong", t("cleanup.found") + ": " + items.length));
    if (items.length) sum.appendChild(el("span", "strong", t("cleanup.reclaim") + ": " + fmtSize(scan.totalSize || 0)));
    if (scan.protectedCount) sum.appendChild(el("span", "", t("cleanup.protected") + ": " + scan.protectedCount));
    body.appendChild(sum);

    // Show which rules produced this list: a shorter list than expected should be
    // explainable without opening Settings.
    const rules = scan.rules || {};
    const ruleBits = [];
    if (rules.keepUntagged) ruleBits.push([t("cleanup.ruleKeep"), rules.keepUntagged, t("cleanup.ruleKeepUnit")].filter(Boolean).join(" "));
    if (rules.minAgeDays) ruleBits.push([t("cleanup.ruleMinAge"), rules.minAgeDays, t("cleanup.ruleDays")].filter(Boolean).join(" "));
    if ((rules.excludeRepos || []).length) ruleBits.push(t("cleanup.ruleExclude") + " " + rules.excludeRepos.join(" "));
    if (ruleBits.length) body.appendChild(el("p", "hint", t("cleanup.byRules") + " — " + ruleBits.join(" · ")));

    if (scan.truncated) body.appendChild(el("p", "hint warn", t("cleanup.truncated")));
    if ((scan.repositoryErrors || []).length) {
      body.appendChild(el("p", "hint warn", t("cleanup.repoErrors") + ": " + scan.repositoryErrors.join("; ")));
    }

    if (!items.length) {
      body.appendChild(el("p", "muted", t("cleanup.none")));
      return;
    }

    body.appendChild(el("p", "hint", t("cleanup.sub")));

    const table = el("table", "table cleanup-table");
    const thead = el("thead");
    const hr = el("tr");
    const thAll = el("th", "col-check");
    const all = el("input");
    all.id = "cleanupAll";
    all.type = "checkbox";
    all.checked = true;
    all.title = t("cleanup.selectAll");
    thAll.appendChild(all);
    hr.appendChild(thAll);
    [t("cleanup.repository"), t("digest"), t("size"), t("pushed"), t("cleanup.status")].forEach((h) => hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);

    const boxes = [];
    const tbody = el("tbody");
    items.forEach((it) => {
      // A rule-protected row stays visible (so the rule is not a mystery) but
      // cannot be selected, and the backend refuses it anyway.
      const blocked = !!it.protected;
      const tr = el("tr", blocked ? "row-blocked" : "");
      const td = el("td", "col-check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !blocked;
      cb.disabled = blocked;
      cb.dataset.repo = it.repository;
      cb.dataset.digest = it.digest;
      td.appendChild(cb);
      tr.appendChild(td);
      tr.appendChild(el("td", "mono", it.repository));
      const tdDigest = el("td", "mono digest-cell");
      const dg = el("span", "", shortDigest(it.digest));
      dg.title = it.digest || "";   // full value stays available on hover
      tdDigest.appendChild(dg);
      tr.appendChild(tdDigest);
      tr.appendChild(el("td", "", fmtSize(it.size)));
      tr.appendChild(el("td", "", fmtTime(it.push_time)));
      const tdStatus = el("td");
      if (blocked) {
        const chip = el("span", "badge warn-soft", t("cleanup.protected"));
        chip.title = it.protectedReason || "";
        tdStatus.appendChild(chip);
        tdStatus.appendChild(el("span", "reason", it.protectedReason || ""));
      } else {
        tdStatus.appendChild(el("span", "badge ok-soft", t("cleanup.eligible")));
      }
      tr.appendChild(tdStatus);
      tbody.appendChild(tr);
      boxes.push({ cb, item: it, blocked });
    });
    table.appendChild(tbody);
    body.appendChild(table);

    const count = () => boxes.filter((b) => b.cb.checked && !b.blocked).length;
    boxes.forEach((b) => b.cb.addEventListener("change", () => setCleanupConfirm(count())));
    all.checked = boxes.some((b) => !b.blocked);
    all.disabled = !all.checked;
    all.addEventListener("change", () => {
      boxes.forEach((b) => { if (!b.blocked) b.cb.checked = all.checked; });
      setCleanupConfirm(count());
    });

    pendingCleanup = { project, boxes };
    setCleanupConfirm(count());   // everything is selected by default
  }

  async function runCleanup() {
    if (!pendingCleanup) return;
    const targets = pendingCleanup.boxes
      .filter((b) => b.cb.checked)
      .map((b) => ({ repository: b.item.repository, reference: b.item.digest, size: b.item.size || 0 }));
    if (!targets.length) { toast(t("cleanup.nothingSelected"), "err"); return; }

    const btn = $("#btnCleanupConfirm");
    btn.disabled = true;
    btn.textContent = t("cleanup.working");
    try {
      const r = await invoke("harbor/cleanupUntagged", { project: pendingCleanup.project, targets });
      $("#cleanupModal").hidden = true;
      const parts = [`${t("cleanup.deleted")} ${r.deletedCount || 0}`];
      if (r.reclaimedBytes) parts.push(`${t("cleanup.reclaimed")} ${fmtSize(r.reclaimedBytes)}`);
      if ((r.skipped || []).length) parts.push(`${t("cleanup.skipped")} ${r.skipped.length}`);
      if ((r.failed || []).length) parts.push(`${t("cleanup.failedCount")} ${r.failed.length}`);
      toast(parts.join(" · "), (r.failed || []).length ? "err" : "ok");
      invalidate(currentKey());
      reloadContent();
    } catch (e) {
      toast(e.message || t("failed"), "err");
    } finally {
      pendingCleanup = null;
      setCleanupConfirm(0);
    }
  }

  async function openLayers(repo, reference) {
    $("#layersModal").hidden = false;
    $("#layersBody").innerHTML = loadingHTML();
    try {
      const r = await invoke("registry/layers", { repository: repo, reference });
      renderLayers(r);
    } catch (e) {
      $("#layersBody").innerHTML = "";
      $("#layersBody").appendChild(el("p", "hint warn", e.message || t("failed")));
    }
  }

  let layerOrder = "index"; // "index" (as built) | "size" (largest first)

  /**
   * Renders the layer breakdown. The size of an individual layer is the whole
   * reason this dialog exists, so it is the prominent element of each row:
   * right-aligned, bold, tabular, with a proportional bar and a share of total.
   */
  function renderLayers(r) {
    const body = $("#layersBody");
    body.innerHTML = "";

    const layers = (r && r.layers) || [];
    const total = (r && r.totalSize) || layers.reduce((a, l) => a + (l.size || 0), 0);
    const biggest = layers.reduce((a, l) => ((l.size || 0) > (a ? a.size || 0 : -1) ? l : a), null);

    const sum = el("div", "layer-summary");
    sum.appendChild(el("span", "", t("layersPlatform") + ": " + (r.platform ? ((r.platform.os || "") + "/" + (r.platform.architecture || "")) : "—")));
    sum.appendChild(el("span", "", t("layersCount") + ": " + layers.length));
    sum.appendChild(el("span", "strong", t("layersTotal") + ": " + fmtSize(total)));
    if (biggest) sum.appendChild(el("span", "", t("layersBiggest") + ": " + fmtSize(biggest.size)));
    sum.appendChild(el("span", "mono", t("digest") + ": " + (r.digest ? r.digest.slice(0, 19) : "—")));
    body.appendChild(sum);

    if (!layers.length) {
      body.appendChild(el("p", "muted", t("layersNone")));
      return;
    }

    const toolbar = el("div", "layer-toolbar");
    toolbar.appendChild(el("span", "layer-toolbar-label", t("layersSort")));
    [["index", t("layersByOrder")], ["size", t("layersBySize")]].forEach(([mode, label]) => {
      const b = el("button", "btn btn-outline btn-sm" + (layerOrder === mode ? " active" : ""), label);
      b.addEventListener("click", () => { layerOrder = mode; renderLayers(r); });
      toolbar.appendChild(b);
    });
    body.appendChild(toolbar);

    const ordered = layerOrder === "size"
      ? layers.slice().sort((a, b) => (b.size || 0) - (a.size || 0))
      : layers;

    const list = el("div", "layer-list");
    ordered.forEach((l) => {
      const size = l.size || 0;
      const pct = total > 0 ? (size / total) * 100 : 0;
      const isBiggest = biggest && l.digest && l.digest === biggest.digest;

      const row = el("div", "layer-row" + (isBiggest ? " biggest" : ""));

      const head = el("div", "layer-head");
      head.appendChild(el("span", "layer-idx", String(l.index)));
      head.appendChild(el("span", "cmd", l.command || t("layersNoCommand")));
      head.appendChild(el("span", "layer-size", fmtSize(size)));
      row.appendChild(head);

      const gauge = el("div", "layer-bar");
      const fill = el("span");
      // Keep a hairline for non-empty layers so they are still visible.
      fill.style.width = (size > 0 ? Math.max(pct, 0.6) : 0).toFixed(2) + "%";
      gauge.appendChild(fill);
      row.appendChild(gauge);

      const meta = el("div", "meta");
      meta.appendChild(el("span", "pct", pct.toFixed(1) + "% " + t("layersOfTotal")));
      if (isBiggest) meta.appendChild(el("span", "tag-chip", t("layersBiggestTag")));
      meta.appendChild(el("span", "mono", (l.digest || "").slice(0, 19) || "—"));
      row.appendChild(meta);

      list.appendChild(row);
    });
    body.appendChild(list);
  }

  const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };
  const severityRank = (v) => SEV_RANK[String(v || "").trim().toLowerCase()] || 0;

  async function openVuln(repo, reference, digest, force) {
    if (state.mode !== "harbor") { toast(t("noVuln"), "ok"); return; }
    const seq = ++state.vulnSeq;
    state.vulnRef = { repo, reference, digest };
    $("#vulnModal").hidden = false;
    $("#vulnBody").innerHTML = loadingHTML();
    try {
      const ref = digest || reference;
      const r = await invoke("harbor/vulnerabilities", {
        project: state.current.project,
        repository: repo.replace(state.current.project + "/", ""),
        reference: ref,
        force: !!force,     // the refresh button bypasses the cache TTL
      });
      if (seq !== state.vulnSeq) return;
      renderVuln(r);
    } catch (e) {
      if (seq !== state.vulnSeq) return;
      $("#vulnBody").innerHTML = "";
      $("#vulnBody").appendChild(el("p", "hint warn", e.message || t("failed")));
    }
  }

  function renderVuln(r) {
    const body = $("#vulnBody");
    body.innerHTML = "";
    if (r && r.disabled) {
      body.appendChild(el("p", "hint warn", r.reason || t("vuln.disabled")));
      return;
    }
    const vuls = (r && r.vulnerabilities) || [];
    const sevs = ["Critical", "High", "Medium", "Low"];
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    if (r && r.counts && typeof r.counts === "object") {
      sevs.forEach((sv) => { counts[sv] = r.counts[sv] || 0; });
    } else {
      vuls.forEach((v) => { if (counts[v.severity] != null) counts[v.severity]++; });
    }
    const threshold = (r && r.threshold) || "high";

    // Threshold context, so a report is read against the configured bar rather
    // than against intuition.
    const meta = el("div", "vuln-meta");
    meta.appendChild(el("span", "", t("vuln.threshold") + ": " + threshold));
    meta.appendChild(el("span", "badge " + (r && r.exceedsThreshold ? "danger-soft" : "ok-soft"),
      r && r.exceedsThreshold ? t("vuln.exceeds") : t("vuln.within")));
    if (r && r.highest) meta.appendChild(el("span", "strong", r.highest));
    if (r && r.scanner) meta.appendChild(el("span", "muted", t("vuln.scanner") + ": " + r.scanner));
    if (r && r.cached) meta.appendChild(el("span", "badge soft", t("vuln.cached")));
    if (r && r.generatedAt) meta.appendChild(el("span", "muted", r.generatedAt));
    body.appendChild(meta);

    const s = el("div", "vuln-summary");
    sevs.forEach((sv) => {
      // A level at or above the threshold is the one that matters, so mark it.
      const over = severityRank(sv) >= severityRank(threshold);
      const box = el("div", "sev-box " + sv.toLowerCase() + (over ? " over" : ""));
      box.appendChild(el("div", "num", String(counts[sv])));
      box.appendChild(el("div", "lbl", sv));
      if (over) box.title = t("vuln.exceeds");
      s.appendChild(box);
    });
    body.appendChild(s);

    const ref = state.vulnRef || {};
    const acts = el("div", "vuln-actions");
    const refresh = el("button", "btn btn-outline btn-sm", t("vuln.refresh"));
    refresh.addEventListener("click", () => openVuln(ref.repo, ref.reference, ref.digest, true));
    acts.appendChild(refresh);
    const rescan = el("button", "btn btn-outline btn-sm");
    rescan.appendChild(svgIcon("scan"));
    rescan.appendChild(el("span", "", t("vuln.rescan")));
    rescan.addEventListener("click", async () => {
      rescan.disabled = true;
      try {
        await invoke("harbor/scan", {
          project: state.current.project,
          repository: (ref.repo || "").replace(state.current.project + "/", ""),
          reference: ref.digest || ref.reference,
        });
        toast(t("vuln.requested"), "ok");
      } catch (e) {
        toast(e.message || t("failed"), "err");
      } finally { rescan.disabled = false; }
    });
    acts.appendChild(rescan);
    body.appendChild(acts);

    if (!vuls.length) { body.appendChild(el("p", "muted", t("noVuln"))); return; }
    const table = el("table", "table vuln-table");
    const thead = el("thead");
    const hr = el("tr");
    [t("severity"), "CVE / ID", "Package", "Version"].forEach((h) => hr.appendChild(el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    vuls.slice(0, 200).forEach((v) => {
      const tr = el("tr");
      const tdS = el("td");
      const sev = el("span", "sev " + (v.severity || ""));
      sev.textContent = v.severity || "—";
      tdS.appendChild(sev);
      tr.appendChild(tdS);
      tr.appendChild(el("td", "mono", v.id || v.cve_id || "—"));
      tr.appendChild(el("td", "", v.package || v.package_name || "—"));
      tr.appendChild(el("td", "mono", v.version || "—"));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /** Read the stored settings once, non-fatally, so policy markers are correct. */
  async function preloadSettings() {
    try {
      const set = await invoke("settings/get", state.connectionId ? { connectionId: state.connectionId } : {});
      state.settings = set.settings;
      state.settingsPath = set.path || "";
      state.settingsIsDefault = !!set.isDefault;
    } catch (_) { /* markers stay absent; the dialog will report the real error */ }
  }

  /* ---------- settings -------------------------------------------------------
   * Settings are stored and enforced by the backend: the sandbox has no durable
   * storage, and policy that the UI alone "remembers" is policy that can be
   * bypassed. This file keeps a draft copy so Cancel really cancels.
   * ------------------------------------------------------------------------- */

  function defaultSettings() {
    return {
      cleanup: { keepUntagged: 0, minAgeDays: 0, excludeRepos: [], maxReposPerScan: 100 },
      retention: { keepTagged: 0, protectTags: ["latest"] },
      scanner: { source: "harbor", threshold: "high", cacheSeconds: 300, autoScan: false, preventVul: false, scannerUuid: "" },
    };
  }

  function settingsOf() {
    return state.settings || defaultSettings();
  }

  function draft() {
    if (!state.settingsDraft) state.settingsDraft = JSON.parse(JSON.stringify(settingsOf()));
    return state.settingsDraft;
  }

  function markDirty() {
    state.settingsDirty = true;
    const btn = $("#btnSettingsSave");
    if (btn) btn.textContent = t("settings.save") + " ●";
    const hint = $("#settingsDirtyHint");
    if (hint) hint.hidden = false;
  }

  /**
   * Glob matching for UI hints only — the backend decides for real. Mirrors
   * path.Match closely enough to warn before a click turns into an error.
   */
  function globMatch(pattern, value) {
    const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    try { return new RegExp("^" + esc + "$", "i").test(String(value)); } catch (_) { return false; }
  }

  function protectedPattern(tag) {
    const list = settingsOf().retention.protectTags || [];
    return list.find((pat) => pat && globMatch(pat, tag)) || null;
  }

  /* ---------- settings form building blocks ---------- */

  function setSection(titleKey, descKey, badgeKey) {
    const sec = el("section", "set-section");
    const head = el("div", "set-head");
    head.appendChild(el("h4", "", t(titleKey)));
    if (badgeKey) head.appendChild(el("span", "badge soft", t(badgeKey)));
    sec.appendChild(head);
    if (descKey) sec.appendChild(el("p", "set-desc", t(descKey)));
    return sec;
  }

  /** A label/help block on the left, the control on the right. */
  function setRow(sec, labelKey, helpKey, control) {
    const row = el("div", "set-row");
    const left = el("div", "set-label");
    left.appendChild(el("div", "lab", t(labelKey)));
    if (helpKey) left.appendChild(el("div", "help", t(helpKey)));
    row.appendChild(left);
    const box = el("div", "set-control");
    box.appendChild(control);
    row.appendChild(box);
    sec.appendChild(row);
    return row;
  }

  function numberControl(value, min, max, onChange) {
    const inp = el("input", "set-input");
    inp.type = "number";
    inp.min = String(min);
    inp.max = String(max);
    inp.value = String(value);
    inp.addEventListener("input", () => {
      const n = parseInt(inp.value, 10);
      onChange(Number.isFinite(n) ? n : 0);
    });
    return inp;
  }

  function selectControl(value, options, onChange) {
    const sel = el("select", "set-select");
    options.forEach((o) => {
      const opt = el("option", "", o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  function switchControl(checked, onChange) {
    const wrap = el("label", "set-switch");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!checked;
    box.addEventListener("change", () => onChange(box.checked));
    wrap.appendChild(box);
    wrap.appendChild(el("span", "track"));
    return wrap;
  }

  function listControl(values, onChange, example) {
    const ta = el("textarea", "set-textarea");
    ta.rows = 3;
    ta.spellcheck = false;
    // An empty box gives no hint about the expected syntax, so show one.
    if (example) ta.placeholder = example;
    ta.value = (values || []).join("\n");
    ta.addEventListener("input", () => {
      onChange(ta.value.split("\n").map((v) => v.trim()).filter((v) => v !== ""));
    });
    return ta;
  }

  /* ---------- settings dialog ---------- */

  async function openSettings() {
    state.settingsDraft = null;
    state.settingsDirty = false;
    $("#settingsModal").hidden = false;
    $("#settingsBody").innerHTML = loadingHTML();
    const btn = $("#btnSettingsSave");
    btn.textContent = t("settings.save");

    let set = null;
    try {
      set = await invoke("settings/get", state.connectionId ? { connectionId: state.connectionId } : {});
      state.settings = set.settings;
      state.settingsPath = set.path || "";
      state.settingsIsDefault = !!set.isDefault;
    } catch (e) {
      $("#settingsBody").innerHTML = "";
      $("#settingsBody").appendChild(el("p", "hint warn", e.message || t("failed")));
      // Saving from here would write defaults over the stored settings, so the
      // action is closed off until a reload succeeds.
      btn.disabled = true;
      return;
    }
    btn.disabled = false;

    if (!state.appInfo) {
      try { state.appInfo = await invoke("app/info", {}); } catch (_) { state.appInfo = {}; }
    }
    renderSettings();
  }

  function renderSettings() {
    const d = draft();
    const body = $("#settingsBody");
    body.innerHTML = "";

    /* scope banner: whose settings these are */
    const scope = el("div", "set-scope");
    const who = state.connInfo.name
      ? state.connInfo.name + (state.connInfo.endpoint ? " · " + state.connInfo.endpoint : "")
      : t("settings.defaults");
    scope.appendChild(el("span", "set-who", who));
    scope.appendChild(el("span", "set-scope-note", t("settings.scope")));
    if (state.settingsIsDefault) scope.appendChild(el("span", "badge soft", t("settings.defaults")));
    const dirtyHint = el("span", "set-dirty", t("settings.dirty"));
    dirtyHint.id = "settingsDirtyHint";
    dirtyHint.hidden = !state.settingsDirty;
    scope.appendChild(dirtyHint);
    body.appendChild(scope);
    if (!state.connectionId) body.appendChild(el("p", "hint warn", t("settings.noConnection")));

    /* The per-folder cleanup/retention policies live in each project's settings
       dialog, and since v1.5.0 so does vulnerability scanning — configured per
       project. The global panel keeps the account-level sections only. */
    /* 4 — user management (Harbor admin) */
    if (state.mode === "harbor") {
      const secU = setSection("user.manage", null);
      secU.appendChild(el("div", "set-sub", t("user.manage")));
      body.appendChild(secU);
      renderUserManagement(secU);
    }

    /* 5 — about */
    body.appendChild(renderAbout());
  }

  /**
   * The Harbor-side half of the scanner section: what the server currently has,
   * and the values this plugin would write. Kept visually separate because it
   * changes the registry, while everything above only changes local policy.
   *
   * Since v1.5.0 this lives in the per-project settings dialog and edits the
   * project-scanner draft (state.projectScannerDraft), not the global one.
   */
  function renderHarborScanPolicy(d) {
    const project = state.projectAdmin ? state.projectAdmin.project : state.current.project;
    const rerender = () => renderProjectSettings(project, state.projectAdmin.data);
    const wrap = el("div", "set-live");
    wrap.appendChild(el("div", "set-sub", t("settings.live")));

    if (state.mode !== "harbor") {
      wrap.appendChild(el("p", "hint", t("settings.notHarbor")));
      return wrap;
    }
    if (!project) {
      wrap.appendChild(el("p", "hint", t("settings.noProject")));
      return wrap;
    }
    if (state.scannerError) {
      wrap.appendChild(el("p", "hint warn", t("settings.loadFailed") + ": " + state.scannerError));
      return wrap;
    }
    const info = state.scannerInfo;
    if (!info) { wrap.appendChild(el("p", "hint", t("settings.loadFailed"))); return wrap; }

    const live = info.project || {};
    const scanners = info.scanners || [];
    // Harbour's own values seed the draft once per open. Re-syncing on every
    // repaint would undo pending edits when the apply button re-renders.
    if (!state.liveSynced) {
      d.scannerUuid = live.scannerUuid || "";
      d.autoScan = !!live.autoScan;
      d.preventVul = !!live.preventVul;
      state.liveSynced = true;
    }

    /* what Harbor has right now */
    const now = el("div", "live-grid");
    const addFact = (k, v) => {
      const cell = el("div", "live-cell");
      cell.appendChild(el("span", "k", k));
      cell.appendChild(el("span", "v", v || "—"));
      now.appendChild(cell);
    };
    const currentScanner = scanners.find((x) => x.uuid === live.scannerUuid);
    addFact(t("settings.projectScanner"),
      live.scannerUuid ? (currentScanner ? currentScanner.name : live.scannerUuid) : t("settings.projectScanner.follow"));
    addFact(t("settings.autoScan"), String(!!live.autoScan));
    addFact(t("settings.preventVul"), String(!!live.preventVul));
    addFact("severity", live.severity || "—");
    if (scanners.length) {
      const names = scanners.map((x) => x.name + (x.is_default ? " (default)" : "")).join(" · ");
      addFact(t("settings.scanners"), names);
    }
    wrap.appendChild(now);

    /* what this plugin would write */
    const options = [];
    // "Follow the system default" is only offered when that is already the case:
    // unsetting a pinned scanner is not something this plugin can do reliably.
    if (!live.scannerUuid) options.push({ value: "", label: t("settings.projectScanner.follow") });
    scanners.forEach((x) => options.push({ value: x.uuid, label: x.name }));
    if (!options.length) options.push({ value: live.scannerUuid || "", label: live.scannerUuid || t("settings.projectScanner.follow") });
    // Any change here must repaint: the pending summary and the apply button are
    // derived from these values, so without a repaint the button would stay
    // disabled and the edit would look ignored.
    const onHarborChange = (apply) => {
      apply();
      state.applyArmed = false;
      rerender();
    };
    setRow(wrap, "settings.projectScanner", null,
      selectControl(d.scannerUuid || "", options,
        (v) => onHarborChange(() => { d.scannerUuid = v; })));
    setRow(wrap, "settings.autoScan", null,
      switchControl(d.autoScan, (v) => onHarborChange(() => { d.autoScan = v; })));
    setRow(wrap, "settings.preventVul", null,
      switchControl(d.preventVul, (v) => onHarborChange(() => { d.preventVul = v; })));
    setRow(wrap, "settings.severityOnHarbor", null,
      switchControl(state.applySeverity, (v) => onHarborChange(() => { state.applySeverity = v; })));

    const pending = pendingApply();
    if (pending.items.length) {
      wrap.appendChild(el("p", "hint", t("settings.applyHint")
        .replace("{project}", project)
        .replace("{items}", pending.items.join(", "))));
    } else {
      wrap.appendChild(el("p", "hint", t("settings.applyNothing")));
    }

    const apply = el("button", "btn btn-outline btn-sm", state.applyArmed ? t("settings.applyArm") : t("settings.apply"));
    apply.id = "btnApplyScanner";
    if (!pending.items.length) apply.disabled = true;
    if (state.applyArmed) apply.className = "btn btn-danger btn-sm";
    apply.addEventListener("click", async () => {
      // Two steps on purpose: this writes to the registry, not to local prefs.
      if (!state.applyArmed) { state.applyArmed = true; rerender(); return; }
      apply.disabled = true;
      try {
        const r = await invoke("harbor/applyScanner", Object.assign({ project }, pending.payload));
        toast((r && r.message) || t("settings.applied"), "ok");
        state.applyArmed = false;
        state.liveSynced = false;
        state.scannerInfo = await invoke("harbor/scannerInfo", { project });
        rerender();
      } catch (e) {
        apply.disabled = false;
        state.applyArmed = false;
        toast(e.message || t("failed"), "err");
        rerender();
      }
    });
    wrap.appendChild(el("div", "set-actions", apply));

    const notes = info.notes || [];
    if (notes.length) {
      const ul = el("ul", "set-notes");
      notes.forEach((nt) => ul.appendChild(el("li", "", nt)));
      wrap.appendChild(el("div", "set-sub", t("settings.notes")));
      wrap.appendChild(ul);
    }
    return wrap;
  }

  /** Only the differences get written, so applying is never a blind overwrite. */
  function pendingApply() {
    const s = state.projectScannerDraft || {};
    const live = (state.scannerInfo && state.scannerInfo.project) || {};
    const items = [];
    const payload = {};
    if (live.scannerUuid !== undefined && (s.scannerUuid || "") !== (live.scannerUuid || "")) {
      payload.scannerUuid = s.scannerUuid || "";
      const chosen = (state.scannerInfo.scanners || []).find((x) => x.uuid === s.scannerUuid);
      items.push(t("settings.projectScanner") + " → " + (chosen ? chosen.name : (s.scannerUuid || t("settings.projectScanner.follow"))));
    }
    if (live.autoScan !== undefined && !!s.autoScan !== !!live.autoScan) {
      payload.autoScan = !!s.autoScan;
      items.push("auto_scan → " + String(!!s.autoScan));
    }
    if (live.preventVul !== undefined && !!s.preventVul !== !!live.preventVul) {
      payload.preventVul = !!s.preventVul;
      items.push("prevent_vul → " + String(!!s.preventVul));
    }
    if (state.applySeverity && (live.severity || "").toLowerCase() !== s.threshold) {
      payload.severity = s.threshold;
      items.push("severity → " + s.threshold);
    }
    return { payload, items };
  }

  function renderAbout() {
    const info = state.appInfo || {};
    const sec = setSection("settings.about", null);
    const grid = el("div", "set-about");
    const line = (k, vEl) => {
      const row = el("div", "about-row");
      row.appendChild(el("span", "k", k));
      const v = el("span", "v");
      v.appendChild(vEl);
      row.appendChild(v);
      grid.appendChild(row);
    };
    line(t("settings.version"), el("span", "mono", info.version || "—"));
    line(t("settings.pluginId"), el("span", "mono", info.pluginId || "—"));
    line(t("settings.protocol"), el("span", "mono", "stdio-jsonl v" + (info.protocolVersion || 1)));
    if (info.github) {
      const a = el("a", "link", info.github);
      a.href = info.github;
      a.target = "_blank";
      a.rel = "noreferrer";
      line(t("settings.github"), a);
    } else {
      // Deliberately not a dead link: the project page does not exist yet.
      line(t("settings.github"), el("span", "muted", t("settings.githubSoon")));
    }
    const pathWrap = el("span", "path-cell");
    pathWrap.appendChild(el("span", "mono", info.settingsPath || state.settingsPath || "—"));
    const cp = el("button", "btn btn-ghost btn-sm", t("settings.copy"));
    cp.addEventListener("click", () => copyText(info.settingsPath || state.settingsPath || "", true));
    pathWrap.appendChild(cp);
    line(t("settings.settingsPath"), pathWrap);
    sec.appendChild(grid);
    return sec;
  }

  async function saveSettings() {
    if (!state.settings) { toast(t("settings.loadFailed"), "err"); return; }
    const d = draft();
    const err = validateDraft(d);
    if (err) { toast(err, "err"); return; }
    const btn = $("#btnSettingsSave");
    btn.disabled = true;
    try {
      const r = await invoke("settings/set", Object.assign(
        { settings: d },
        state.connectionId ? { connectionId: state.connectionId } : {}));
      state.settings = r.settings;
      state.settingsPath = r.path || state.settingsPath;
      state.settingsIsDefault = false;
      state.settingsDraft = null;
      state.settingsDirty = false;
      toast(t("settings.saved"), "ok");
      renderSettings();
      // Retention markers and the cleanup dialog are derived from settings, so
      // repaint the current view (the listing itself is still cached).
      if (state.current.repo) reloadContent();
    } catch (e) {
      toast(e.message || t("failed"), "err");
    } finally { btn.disabled = false; }
  }

  /**
   * Mirrors the backend's validation so a typo is caught before a round trip.
   * The backend still validates — this is convenience, not authority.
   */
  function validateDraft(d) {
    const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!inRange(d.cleanup.keepUntagged, 0, 1000)) return t("settings.keepUntagged");
    if (!inRange(d.cleanup.minAgeDays, 0, 3650)) return t("settings.minAgeDays");
    if (!inRange(d.cleanup.maxReposPerScan, 1, 500)) return t("settings.maxReposPerScan");
    if (!inRange(d.retention.keepTagged, 0, 1000)) return t("settings.keepTagged");
    if (!inRange(d.scanner.cacheSeconds, 0, 86400)) return t("settings.cacheSeconds");
    const badGlob = (list) => (list || []).find((x) => {
      // An unbalanced [ or ] is the realistic typo here.
      return (x.match(/\[/g) || []).length !== (x.match(/\]/g) || []).length;
    });
    const bad1 = badGlob(d.cleanup.excludeRepos);
    if (bad1) return "excludeRepos: " + bad1;
    const bad2 = badGlob(d.retention.protectTags);
    if (bad2) return "protectTags: " + bad2;
    return "";
  }

  async function resetSettings() {
    try {
      const r = await invoke("settings/reset", state.connectionId ? { connectionId: state.connectionId } : {});
      state.settings = r.settings;
      state.settingsDraft = null;
      state.settingsDirty = false;
      state.settingsIsDefault = true;
      state.applySeverity = false;
      state.applyArmed = false;
      state.liveSynced = false;
      toast(r.message || t("settings.reset"), "ok");
      renderSettings();
      if (state.current.repo) reloadContent();
    } catch (e) {
      toast(e.message || t("failed"), "err");
    }
  }

  /* ---------- per-folder project settings + user management ---------- */

  const ROLE_OPTIONS = [1, 2, 3, 4, 5];
  const roleLabel = (id) => t("role." + id) || ("role-" + id);

  /**
   * A two-stop slider for the project access level: Private ←→ Public. Click
   * (or press Enter/Space) flips the stop; the labels light up for the active
   * side. The caller owns persistence — a failed write re-opens the dialog,
   * which restores the true value.
   */
  function accessSlider(isPublic, onChange) {
    let current = !!isPublic;
    const wrap = el("div", "acc-slider" + (current ? " is-public" : ""));
    wrap.setAttribute("role", "switch");
    wrap.setAttribute("aria-checked", String(current));
    wrap.tabIndex = 0;

    const priv = el("span", "acc-label" + (current ? "" : " on"), t("acc.private"));
    const pub = el("span", "acc-label" + (current ? " on" : ""), t("acc.public"));
    const track = el("span", "acc-track");
    track.appendChild(el("span", "acc-thumb"));

    const flip = () => {
      current = !current;
      wrap.classList.toggle("is-public", current);
      priv.classList.toggle("on", !current);
      pub.classList.toggle("on", current);
      wrap.setAttribute("aria-checked", String(current));
      onChange(current);
    };
    track.addEventListener("click", flip);
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
    });
    wrap.append(priv, track, pub);
    return wrap;
  }

  /** Quota: what the project uses now, and the cap the operator can change. */
  function renderQuotaSection(project) {
    const sec = setSection("project.quota", "project.quotaDesc");
    if (state.quotaError) {
      sec.appendChild(el("p", "hint warn", t("project.quotaFailed") + ": " + state.quotaError));
      return sec;
    }
    const q = state.quota;
    if (!q) return sec;

    const grid = el("div", "live-grid");
    const addFact = (k, v) => {
      const cell = el("div", "live-cell");
      cell.appendChild(el("span", "k", k));
      cell.appendChild(el("span", "v", v || "—"));
      grid.appendChild(cell);
    };
    addFact(t("project.quotaUsed"), fmtSize(q.usedBytes));
    addFact(t("project.quotaHard"), q.hardBytes < 0 ? t("project.quotaUnlimited") : fmtSize(q.hardBytes));
    sec.appendChild(grid);

    const GB = 1024 * 1024 * 1024;
    const gbValue = q.hardBytes < 0 ? -1 : Math.round((q.hardBytes / GB) * 10) / 10;
    const inp = el("input", "set-input");
    inp.type = "number";
    inp.step = "0.1";
    inp.value = String(gbValue);
    setRow(sec, "project.quotaHard", "project.quotaHard.help", inp);

    const btn = el("button", "btn btn-primary btn-sm", t("settings.save"));
    btn.addEventListener("click", async () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) { toast(t("project.quotaHard") + "?", "err"); return; }
      const hardBytes = v < 0 ? -1 : Math.round(v * GB);
      btn.disabled = true;
      try {
        await invoke("harbor/quotaSet", { project, hardBytes, connectionId: state.connectionId });
        toast(t("project.quotaSaved"), "ok");
        openProjectSettings(project);
      } catch (e) { toast(e.message || t("failed"), "err"); btn.disabled = false; }
    });
    sec.appendChild(el("div", "set-actions", btn));
    return sec;
  }

  /**
   * Per-project vulnerability scanning: the local policy (threshold, cache,
   * panel on/off) plus the Harbor-side policy rows moved here from the old
   * global scanner panel. The local part saves via settings/setProject; the
   * Harbor part keeps its explicit two-step apply.
   */
  function renderProjectScannerSection(project) {
    const d = state.projectScannerDraft;
    const sec = setSection("project.scanner", "settings.scanner.descProject");
    if (state.projectScannerDefault) {
      sec.appendChild(el("p", "hint", t("settings.defaults")));
    }

    setRow(sec, "settings.scannerSource", null,
      selectControl(d.source, [
        { value: "harbor", label: t("settings.scannerSource.harbor") },
        { value: "off", label: t("settings.scannerSource.off") },
      ], (v) => { d.source = v; }));
    setRow(sec, "settings.threshold", null,
      selectControl(d.threshold, ["critical", "high", "medium", "low"].map((v) => ({
        value: v, label: t("settings.sev." + v),
      })), (v) => { d.threshold = v; }));
    setRow(sec, "settings.cacheSeconds", "settings.cacheSeconds.help",
      numberControl(d.cacheSeconds, 0, 86400, (v) => { d.cacheSeconds = v; }));

    sec.appendChild(renderHarborScanPolicy(d));

    const save = el("button", "btn btn-primary btn-sm", t("settings.saveProject"));
    save.addEventListener("click", async () => {
      if (d.cacheSeconds < 0 || d.cacheSeconds > 86400) { toast(t("settings.cacheSeconds"), "err"); return; }
      save.disabled = true;
      try {
        await invoke("settings/setProject", { project, scanner: d, connectionId: state.connectionId });
        state.projectScannerDefault = false;
        toast(t("settings.projectSaved"), "ok");
      } catch (e) {
        toast(e.message || t("failed"), "err");
      } finally { save.disabled = false; }
    });
    sec.appendChild(el("div", "set-actions", save));
    return sec;
  }

  async function openProjectSettings(project) {
    if (state.mode !== "harbor") { toast(t("project.onlyHarbor"), "err"); return; }
    $("#projectSettingsModal").hidden = false;
    $("#projectSettingsBody").innerHTML = loadingHTML();
    // Quota, the Harbor-side scanner policy and the project's scanner settings
    // are independent reads: a failure in one must not blank the whole dialog.
    const [adminR, quotaR, scanR, scannerSetR] = await Promise.allSettled([
      invoke("harbor/projectAdmin", { project, connectionId: state.connectionId }),
      invoke("harbor/quotaGet", { project, connectionId: state.connectionId }),
      invoke("harbor/scannerInfo", { project, connectionId: state.connectionId }),
      invoke("settings/getProject", { project, connectionId: state.connectionId }),
    ]);
    if (adminR.status !== "fulfilled") {
      $("#projectSettingsBody").innerHTML = "";
      $("#projectSettingsBody").appendChild(el("p", "hint warn", adminR.reason?.message || t("project.loadFailed")));
      return;
    }
    const data = adminR.value;
    state.projectAdmin = { project, data };
    state.quota = quotaR.status === "fulfilled" ? quotaR.value : null;
    state.quotaError = quotaR.status === "fulfilled" ? null : (quotaR.reason?.message || t("project.quotaFailed"));
    state.scannerInfo = scanR.status === "fulfilled" ? scanR.value : null;
    state.scannerError = scanR.status === "fulfilled" ? null : (scanR.reason?.message || t("failed"));
    const baseScanner = scannerSetR.status === "fulfilled" ? scannerSetR.value.scanner : defaultSettings().scanner;
    state.projectScannerDefault = scannerSetR.status === "fulfilled" ? !!scannerSetR.value.isDefault : true;
    // Draft copies so cancelling really cancels: local edits are discarded, and
    // the Harbor-side live values are re-seeded once per open.
    state.projectScannerDraft = JSON.parse(JSON.stringify(baseScanner));
    state.applySeverity = false;
    state.applyArmed = false;
    state.liveSynced = false;
    renderProjectSettings(project, data);
  }

  function renderProjectSettings(project, data) {
    const body = $("#projectSettingsBody");
    body.innerHTML = "";
    const proj = data.project || {};
    if (data.projectError) body.appendChild(el("p", "hint warn", t("project.loadFailed") + ": " + data.projectError));

    /* --- access level (private / public, as a two-stop slider) --- */
    if (!data.projectError) {
      const secV = setSection("project.accessLevel", "project.publicDesc");
      setRow(secV, "project.accessLevel", null, accessSlider(!!proj.public, async (on) => {
        try {
          await invoke("harbor/projectSetPublic", { project, public: on, connectionId: state.connectionId });
          toast(t("project.publicSaved"), "ok");
          proj.public = on;
        } catch (e) {
          toast(e.message || t("failed"), "err");
          openProjectSettings(project);   // re-read and restore the slider
        }
      }));
      body.appendChild(secV);
    }

    /* --- storage quota --- */
    body.appendChild(renderQuotaSection(project));

    /* --- vulnerability scanning (this project) --- */
    body.appendChild(renderProjectScannerSection(project));

    /* --- members --- */
    const secM = setSection("project.members", null);
    const members = data.members || [];
    if (data.membersError) {
      secM.appendChild(el("p", "hint warn", data.membersError));
    } else if (!members.length) {
      secM.appendChild(el("p", "muted", t("project.memberEmpty")));
    } else {
      const tbl = el("table", "table admin-table");
      const hr = el("tr");
      [t("project.memberUser"), t("project.memberRole"), ""].forEach((h) => hr.appendChild(el("th", "", h)));
      tbl.appendChild(hr);
      const tb = el("tbody");
      members.forEach((m) => {
        const tr = el("tr");
        tr.appendChild(el("td", "", m.entity_name || m.username || "—"));
        const tdRole = el("td");
        const sel = el("select", "set-select set-select-sm");
        ROLE_OPTIONS.forEach((v) => {
          const opt = el("option", "", roleLabel(v));
          opt.value = String(v);
          if (v === m.role_id) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener("change", async () => {
          try {
            await invoke("harbor/memberRole", { project, memberId: m.id, roleId: Number(sel.value), connectionId: state.connectionId });
            toast(t("done"), "ok");
          } catch (e) { toast(e.message || t("failed"), "err"); sel.value = String(m.role_id); }
        });
        tdRole.appendChild(sel);
        tr.appendChild(tdRole);
        const tdDel = el("td");
        tdDel.appendChild(iconBtn(t("user.delete"), "close", () => removeMember(project, m), "danger"));
        tr.appendChild(tdDel);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      secM.appendChild(tbl);
    }

    const addRow = el("div", "member-add");
    const uSel = el("select", "set-select");
    const ph = el("option", "", t("project.memberUser"));
    ph.value = ""; ph.disabled = true; ph.selected = true;
    uSel.appendChild(ph);
    const users = data.users || [];
    if (data.usersError) {
      addRow.appendChild(el("span", "hint warn", data.usersError));
    } else {
      users.forEach((u) => { const o = el("option", "", u.username); o.value = u.username; uSel.appendChild(o); });
    }
    addRow.appendChild(uSel);
    const rSel = el("select", "set-select");
    ROLE_OPTIONS.forEach((v) => { const o = el("option", "", roleLabel(v)); o.value = String(v); rSel.appendChild(o); });
    addRow.appendChild(rSel);
    const addBtn = el("button", "btn btn-primary btn-sm", t("project.memberAdd"));
    addBtn.addEventListener("click", async () => {
      if (!uSel.value) { toast(t("project.memberUser") + "?", "err"); return; }
      addBtn.disabled = true;
      try {
        await invoke("harbor/memberAdd", { project, roleId: Number(rSel.value), username: uSel.value, connectionId: state.connectionId });
        toast(t("done"), "ok");
        openProjectSettings(project);
      } catch (e) { toast(e.message || t("failed"), "err"); addBtn.disabled = false; }
    });
    addRow.appendChild(addBtn);
    secM.appendChild(addRow);
    body.appendChild(secM);

    /* --- retention --- */
    const secR = setSection("project.retention", null);
    secR.appendChild(el("p", "hint", t("project.retentionHint")));
    const ret = data.retention;
    if (data.retentionError) secR.appendChild(el("p", "hint warn", data.retentionError));
    else if (!ret) secR.appendChild(el("p", "muted", t("project.retentionNone")));
    const keepN = numberControl(0, 0, 1000, () => {});
    const daysN = numberControl(0, 0, 3650, () => {});
    if (ret && ret.rules) {
      ret.rules.forEach((r) => {
        if (r.template === "latestPushedK" && r.params && r.params.latestPushedK != null) keepN.value = String(r.params.latestPushedK);
        if (r.template === "nDaysSinceLastPush" && r.params && r.params.nDaysSinceLastPush != null) daysN.value = String(r.params.nDaysSinceLastPush);
      });
    }
    const cron = el("input", "set-input set-input-cron");
    cron.value = (ret && ret.trigger && ret.trigger.settings && ret.trigger.settings.cron) || "0 0 2 * * *";
    setRow(secR, "project.retentionKeep", null, keepN);
    setRow(secR, "project.retentionDays", null, daysN);
    setRow(secR, "project.retentionCron", null, cron);
    const saveBtn = el("button", "btn btn-primary btn-sm", t("project.retentionSave"));
    saveBtn.addEventListener("click", async () => {
      const k = Number(keepN.value || 0), d = Number(daysN.value || 0);
      const rules = [];
      const tagSel = [{ kind: "doublestar", decoration: "matches", pattern: "**" }];
      const repoSel = { repository: [{ kind: "doublestar", decoration: "repoMatches", pattern: "**" }] };
      if (k > 0) rules.push({ disabled: false, action: "retain", template: "latestPushedK", params: { latestPushedK: k }, tag_selectors: tagSel, scope_selectors: repoSel });
      if (d > 0) rules.push({ disabled: false, action: "retain", template: "nDaysSinceLastPush", params: { nDaysSinceLastPush: d }, tag_selectors: tagSel, scope_selectors: repoSel });
      if (!rules.length) { toast(t("project.retentionKeep") + "?", "err"); return; }
      const policy = {
        id: (ret && ret.id) || 0,
        algorithm: "or",
        rules,
        trigger: { kind: "Schedule", settings: { cron: cron.value || "0 0 2 * * *" } },
        scope: (ret && ret.scope) || { level: "project", ref: proj.projectId || 0 },
      };
      saveBtn.disabled = true;
      try {
        await invoke("harbor/retentionSave", { project, projectId: proj.projectId || 0, policy, connectionId: state.connectionId });
        toast(t("project.retentionSaved"), "ok");
        openProjectSettings(project);
      } catch (e) { toast(e.message || t("failed"), "err"); saveBtn.disabled = false; }
    });
    const acts = el("div", "set-actions"); acts.appendChild(saveBtn);
    secR.appendChild(acts);
    body.appendChild(secR);
  }

  async function removeMember(project, m) {
    try {
      await invoke("harbor/memberRemove", { project, memberId: m.id, connectionId: state.connectionId });
      toast(t("done"), "ok");
      openProjectSettings(project);
    } catch (e) { toast(e.message || t("failed"), "err"); }
  }

  async function renderUserManagement(sec) {
    const box = el("div", "user-box");
    sec.appendChild(box);
    box.innerHTML = loadingHTML();
    let me, users;
    try {
      [me, users] = await Promise.all([
        invoke("harbor/currentUser", { connectionId: state.connectionId }),
        invoke("harbor/users", { connectionId: state.connectionId }),
      ]);
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(el("p", "hint warn", e.message || t("failed")));
      return;
    }
    box.innerHTML = "";
    const isAdmin = !!(me && me.admin);
    const self = (me && me.user) || {};

    // Non-admin: no create-user, no admin toggle — just the operator's own
    // profile, read-only.
    if (!isAdmin) {
      box.appendChild(el("p", "hint", t("user.readonlyHint")));
      const tbl = el("table", "table admin-table");
      const hr = el("tr");
      [t("user.username"), t("user.email"), t("user.admin")].forEach((h) => hr.appendChild(el("th", "", h)));
      tbl.appendChild(hr);
      const tr = el("tr");
      tr.appendChild(el("td", "", self.username || "—"));
      tr.appendChild(el("td", "", self.email || "—"));
      const tdA = el("td");
      if (self.sysadmin_flag) tdA.appendChild(el("span", "badge ok-soft", t("user.admin")));
      tr.appendChild(tdA);
      tbl.appendChild(tr);
      box.appendChild(tbl);
      return;
    }

    // Admin: create-user form + the full user table, each row carrying an
    // "设为管理员" switch.
    const form = el("div", "user-create");
    const uname = el("input", "set-input"); uname.placeholder = t("user.username");
    const email = el("input", "set-input"); email.placeholder = t("user.email");
    const real = el("input", "set-input"); real.placeholder = t("user.realname");
    const pwd = el("input", "set-input"); pwd.type = "password"; pwd.placeholder = t("user.password");
    const createBtn = el("button", "btn btn-primary btn-sm", t("user.create"));
    createBtn.addEventListener("click", async () => {
      if (!uname.value.trim() || !pwd.value) { toast(t("user.username") + " / " + t("user.password") + "?", "err"); return; }
      createBtn.disabled = true;
      try {
        await invoke("harbor/userCreate", { username: uname.value.trim(), email: email.value.trim(), realname: real.value.trim(), password: pwd.value, connectionId: state.connectionId });
        toast(t("user.created"), "ok");
        renderUserManagement(sec);
      } catch (e) { toast(e.message || t("failed"), "err"); createBtn.disabled = false; }
    });
    form.append(uname, email, real, pwd, createBtn);
    box.appendChild(form);
    if (!users.length) { box.appendChild(el("p", "muted", t("user.none"))); return; }

    const tbl = el("table", "table admin-table");
    const hr = el("tr");
    [t("user.username"), t("user.email"), t("user.admin"), ""].forEach((h) => hr.appendChild(el("th", "", h)));
    tbl.appendChild(hr);
    const tb = el("tbody");
    users.forEach((u) => {
      const isSelf = u.username === self.username;
      const tr = el("tr");
      tr.appendChild(el("td", "", u.username));
      tr.appendChild(el("td", "", u.email || "—"));
      const tdAdmin = el("td");
      if (isSelf) {
        // You cannot demote yourself out of admin — show the fact, not a switch.
        if (u.sysadmin_flag) tdAdmin.appendChild(el("span", "badge ok-soft", t("user.admin")));
      } else {
        const sw = switchControl(!!u.sysadmin_flag, (on) => setUserAdmin(u, on, sec));
        sw.title = t("user.setAdmin");
        tdAdmin.appendChild(sw);
      }
      tr.appendChild(tdAdmin);
      const tdActs = el("td");
      const acts = el("div", "actions");
      const pwdBtn = el("button", "btn btn-outline btn-sm", t("user.setPwd"));
      pwdBtn.addEventListener("click", () => setUserPassword(tr, u, pwdBtn));
      acts.appendChild(pwdBtn);
      if (!isSelf) {
        const delBtn = el("button", "btn btn-outline btn-sm btn-danger-outline", t("user.delete"));
        delBtn.addEventListener("click", () => removeUser(u, sec));
        acts.appendChild(delBtn);
      }
      tdActs.appendChild(acts);
      tr.appendChild(tdActs);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    box.appendChild(tbl);
  }

  async function setUserAdmin(u, on, sec) {
    try {
      await invoke("harbor/userAdmin", { userId: u.user_id, admin: on, connectionId: state.connectionId });
      toast(t("done"), "ok");
      renderUserManagement(sec);
    } catch (e) { toast(e.message || t("failed"), "err"); }
  }

  function setUserPassword(tr, u, btn) {
    const td = tr.querySelector("td:last-child");
    td.innerHTML = "";
    const inp = el("input", "set-input"); inp.type = "password"; inp.placeholder = t("user.newPassword");
    const ok = el("button", "btn btn-primary btn-sm", t("done"));
    ok.addEventListener("click", async () => {
      if (!inp.value) { toast(t("user.newPassword") + "?", "err"); return; }
      ok.disabled = true;
      try {
        await invoke("harbor/userPassword", { userId: u.user_id, newPassword: inp.value, connectionId: state.connectionId });
        toast(t("user.passwordSet"), "ok");
        td.innerHTML = ""; td.appendChild(btn);
      } catch (e) { toast(e.message || t("failed"), "err"); ok.disabled = false; }
    });
    td.append(inp, ok);
  }

  async function removeUser(u, sec) {
    try {
      await invoke("harbor/userDelete", { userId: u.user_id, connectionId: state.connectionId });
      toast(t("done"), "ok");
      renderUserManagement(sec);
    } catch (e) { toast(e.message || t("failed"), "err"); }
  }

  /* ---------- registry-wide overview (left-sidebar tab) ---------- */

  /** Switch the left-sidebar tab. */
  function switchTab(tab) {
    state.sidebarTab = tab;
    renderSidebar();
    if (tab === "overview") {
      // The overview is its own view: a stale project/repo trail would point
      // nowhere from here.
      setCrumbs([{ name: t("ov.title") }]);
      renderOverviewPane();
    }
  }

  /**
   * Fetches the registry overview once and caches it. The sidebar tab renders
   * the two project lists; the content pane renders the totals. Clicking a
   * project link jumps to the projects tab and expands that project.
   */
  async function ensureOverview() {
    if (state.overview) return state.overview;
    state.overview = await invoke(state.mode === "harbor" ? "harbor/overview" : "registry/overview", {});
    return state.overview;
  }

  async function renderOverviewList() {
    const box = $("#overviewList");
    box.innerHTML = loadingHTML();
    let o;
    try {
      o = await ensureOverview();
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(el("p", "hint warn", e.message || t("failed")));
      return;
    }
    box.innerHTML = "";
    const linkList = (title, items, key) => {
      box.appendChild(el("div", "ov-sec-title", t(title)));
      if (!items.length) {
        box.appendChild(el("p", "muted", t("noData")));
        return;
      }
      for (const it of items) {
        const a = el("a", "ov-project-link", it.name);
        a.href = "#";
        a.title = it.name;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          openProjectFromOverview(it.name);
        });
        box.appendChild(a);
      }
    };
    linkList("ov.recent", o.recentProjects || []);
    linkList("ov.topPulled", o.topPulled || []);
    if (state.mode !== "harbor") {
      linkList("ov.namespaces", o.namespaces || []);
    }
  }

  /**
   * Jump from an overview link to a specific project: switch to the projects
   * tab, then expand + locate that project. goToProject handles the expansion,
   * sidebar highlight and content overview — switching the tab first is what
   * makes the sidebar actually reveal the target after the "collapse the
   * project tab" path.
   */
  function openProjectFromOverview(name) {
    state.sidebarTab = "projects";
    renderSidebar();
    goToProject(name);
  }

  /** The content pane for the overview tab: the four totals + pull window. */
  function renderOverviewPane() {
    const body = $("#contentBody");
    body.innerHTML = loadingHTML();
    ensureOverview().then((o) => {
      body.innerHTML = "";
      body.appendChild(el("h2", "pane-title", t("ov.title")));
      const stats = el("div", "img-stats");
      const stat = (label, value, strong) => {
        const c = el("div", "img-stat");
        c.appendChild(el("span", "k", label));
        c.appendChild(el("span", "v" + (strong ? " strong" : ""), value));
        stats.appendChild(c);
      };
      stat(t("ov.projects"), String(o.projectCount != null ? o.projectCount : o.namespaceCount || 0), true);
      stat(t("ov.repos"), String(o.repoCount || 0));
      stat(t("ov.images"), String(o.imageCount || 0), true);
      stat(t("ov.size"), fmtSize(o.totalSize || 0), true);
      body.appendChild(stats);

      if (state.mode === "harbor") {
        // Pull window: all three counts arrive in one payload, so switching the
        // window never costs another request.
        const row = el("div", "ov-pull-row");
        row.appendChild(el("span", "k", t("ov.pulls")));
        const seg = el("div", "seg");
        [1, 3, 7].forEach((d) => {
          const b = el("button", "btn btn-sm" + (state.overviewWindow === d ? " seg-on" : " btn-ghost"),
            t("ov.days").replace("{n}", String(d)));
          b.addEventListener("click", () => { state.overviewWindow = d; renderOverviewPane(); });
          seg.appendChild(b);
        });
        row.appendChild(seg);
        row.appendChild(el("span", "v strong", String((o.pullCounts || {})[String(state.overviewWindow)] || 0)));
        body.appendChild(row);
        if (o.pullTruncated) body.appendChild(el("p", "hint", t("ov.truncated")));
      }

      // Charts: storage distribution always; Harbor adds most-pulled projects.
      if (state.mode === "harbor") {
        body.appendChild(hBarChart(t("ov.topPulled"),
          (o.topPulled || []).map((p) => ({ label: p.name, value: p.pulls })), (v) => String(v)));
      }
      const sizeItems = state.mode === "harbor" ? (o.sizeByProject || []) : (o.sizeByNamespace || []);
      body.appendChild(hBarChart(t(state.mode === "harbor" ? "ov.sizeByProject" : "ov.sizeByNamespace"),
        sizeItems.map((p) => ({ label: p.name, value: p.size })), fmtSize));

      if (o.truncated) body.appendChild(el("p", "hint", t("ov.truncated")));
      const errs = o.projectErrors || o.errors || [];
      if (errs.length) {
        const p = el("p", "hint warn", t("ov.errors") + " (" + errs.length + ")");
        p.title = errs.join("\n");
        body.appendChild(p);
      }
    }).catch((e) => {
      body.innerHTML = "";
      body.appendChild(el("p", "hint warn", e.message || t("failed")));
    });
  }

  /**
   * A horizontal bar chart rendered as inline SVG. Items are {label, value};
   * `fmt` turns a value into its display string. Pure SVG + textContent, so no
   * HTML injection and no external chart library in the sandbox.
   */
  function hBarChart(title, items, fmt) {
    const card = el("div", "ov-chart");
    card.appendChild(el("div", "ov-chart-title", title));
    const rows = (items || []).filter((i) => (Number(i.value) || 0) > 0).slice(0, 8);
    if (!rows.length) {
      card.appendChild(el("p", "muted", t("noData")));
      return card;
    }
    const max = Math.max(1, ...rows.map((i) => Number(i.value) || 0));
    const labelW = 148, barMaxW = 300, rowH = 26, padL = 4;
    const w = labelW + barMaxW + 90;
    const h = rows.length * rowH + 8;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(h));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", title);
    rows.forEach((it, idx) => {
      const val = Number(it.value) || 0;
      const y = idx * rowH + 14;
      const barW = Math.max(2, Math.round((val / max) * barMaxW));
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", padL);
      label.setAttribute("y", y);
      label.setAttribute("font-size", "12");
      label.setAttribute("fill", "var(--im-fg-muted)");
      label.textContent = String(it.label).length > 22 ? String(it.label).slice(0, 21) + "…" : String(it.label);
      svg.appendChild(label);
      const bar = document.createElementNS(NS, "rect");
      bar.setAttribute("x", labelW);
      bar.setAttribute("y", y - 11);
      bar.setAttribute("width", barW);
      bar.setAttribute("height", "16");
      bar.setAttribute("rx", "3");
      bar.setAttribute("fill", "var(--im-primary-solid)");
      bar.setAttribute("opacity", "0.9");
      svg.appendChild(bar);
      const value = document.createElementNS(NS, "text");
      value.setAttribute("x", labelW + barW + 6);
      value.setAttribute("y", y);
      value.setAttribute("font-size", "12");
      value.setAttribute("fill", "var(--im-fg)");
      value.textContent = fmt ? fmt(val) : String(val);
      svg.appendChild(value);
    });
    card.appendChild(svg);
    return card;
  }

  /* ---------- audit logs ---------- */

  const LOG_OPERATIONS = ["pull", "push", "create", "delete"];

  async function openLogs() {
    $("#logsModal").hidden = false;
    state.logs = { page: 1, op: "", scope: state.current.project || "", rows: [], pageSize: 50 };
    await renderLogs();
  }

  async function renderLogs() {
    const body = $("#logsBody");
    const st = state.logs;
    body.innerHTML = "";

    /* controls: scope + operation filter */
    const bar = el("div", "logs-bar");
    const scopeSel = el("select", "set-select");
    const all = el("option", "", t("logs.scopeAll"));
    all.value = "";
    scopeSel.appendChild(all);
    if (state.current.project) {
      const o = el("option", "", state.current.project);
      o.value = state.current.project;
      scopeSel.appendChild(o);
    }
    scopeSel.value = st.scope;
    scopeSel.addEventListener("change", () => { st.scope = scopeSel.value; st.page = 1; renderLogs(); });
    const opSel = el("select", "set-select");
    const allOp = el("option", "", t("logs.operation") + " · " + t("logs.all"));
    allOp.value = "";
    opSel.appendChild(allOp);
    LOG_OPERATIONS.forEach((op) => { const o = el("option", "", op); o.value = op; opSel.appendChild(o); });
    opSel.value = st.op;
    opSel.addEventListener("change", () => { st.op = opSel.value; st.page = 1; renderLogs(); });
    bar.append(el("span", "k", t("logs.scope")), scopeSel, el("span", "k", t("logs.operation")), opSel);
    body.appendChild(bar);
    // loadingHTML() is a string; appendChild would throw on it.
    body.insertAdjacentHTML("beforeend", loadingHTML());
    try {
      const params = { page: st.page, pageSize: st.pageSize };
      if (st.scope) params.project = st.scope;
      if (st.op) params.operation = st.op;
      const r = await invoke("harbor/logs", params);
      body.innerHTML = "";
      body.appendChild(bar);
      st.rows = r.logs || [];

      if (!st.rows.length) {
        body.appendChild(el("p", "muted", t("logs.empty")));
        return;
      }
      const tbl = el("table", "table");
      const hr = el("tr");
      [t("logs.time"), t("logs.op"), t("logs.resource"), t("logs.user")].forEach((h) => hr.appendChild(el("th", "", h)));
      tbl.appendChild(hr);
      const tb = el("tbody");
      st.rows.forEach((l) => {
        const tr = el("tr");
        tr.appendChild(el("td", "", fmtTime(l.time)));
        const tdOp = el("td");
        tdOp.appendChild(el("span", "badge soft log-op log-op-" + l.operation, l.operation || "—"));
        tr.appendChild(tdOp);
        const tdRes = el("td");
        const res = el("span", "mono", l.resource || "—");
        res.title = l.resource || "";
        tdRes.appendChild(res);
        tr.appendChild(tdRes);
        tr.appendChild(el("td", "", l.username || "—"));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      body.appendChild(tbl);

      /* pager: Harbor returns at most pageSize rows per page */
      const pager = el("div", "set-actions logs-pager");
      const prev = el("button", "btn btn-outline btn-sm", t("logs.prev"));
      prev.disabled = st.page <= 1;
      prev.addEventListener("click", () => { st.page--; renderLogs(); });
      const next = el("button", "btn btn-outline btn-sm", t("logs.next"));
      next.disabled = st.rows.length < st.pageSize;
      next.addEventListener("click", () => { st.page++; renderLogs(); });
      pager.append(prev, next);
      body.appendChild(pager);
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(el("p", "hint warn", t("logs.loadFailed") + ": " + (e.message || t("failed"))));
    }
  }

  /* ---------- create project ---------- */

  function openCreateProject() {
    if (state.mode !== "harbor") { toast(t("project.onlyHarbor"), "err"); return; }
    $("#newProjectName").value = "";
    state.createPublic = false;
    const box = $("#newProjectAccess");
    box.innerHTML = "";
    box.appendChild(accessSlider(false, (on) => { state.createPublic = on; }));
    $("#createProjectModal").hidden = false;
    $("#newProjectName").focus();
  }

  async function submitCreateProject() {
    const name = $("#newProjectName").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(name)) { toast(t("np.nameInvalid"), "err"); return; }
    const btn = $("#btnCreateProjectConfirm");
    btn.disabled = true;
    try {
      await invoke("harbor/projectCreate", { name, public: !!state.createPublic });
      $("#createProjectModal").hidden = true;
      toast(t("np.created") + ": " + name, "ok");
      // The sidebar tree is derived from the project list — refresh it.
      const projects = await invoke("harbor/projects");
      if (Array.isArray(projects)) { state.projects = projects; renderSidebar(); }
    } catch (e) {
      toast(e.message || t("failed"), "err");
    } finally { btn.disabled = false; }
  }

  /* ---------- modals & events ---------- */
  function shortRepo() {
    const p = state.current.project;
    const r = state.current.repo;
    return p && r && r.startsWith(p + "/") ? r.slice(p.length + 1) : r;
  }
  /**
   * Re-reads the current repository. `force` drops the cached copy first, which is
   * what the refresh button wants; switching between list and card view reuses it.
   */
  function reloadContent(force) {
    // A project with no repository selected shows the project overview.
    if (!state.current.repo && state.current.project) {
      if (state.mode === "harbor") {
        if (force) invalidate(cacheKey("images", state.current.project, ""));
        showProjectImages(state.current.project);
      } else {
        if (force) invalidate(cacheKey("v2images", state.current.project, ""));
        showV2ProjectOverview(state.current.project);
      }
      return;
    }
    if (!state.current.repo) { bootstrap(); return; }
    if (force) invalidate(currentKey());
    showRepo(state.mode === "harbor" ? state.current.project : null,
             state.mode === "harbor" ? shortRepo() : state.current.repo);
  }

  function setupUI() {
    $("#btnRefresh").addEventListener("click", () => reloadContent(true));
    $("#btnSettings").addEventListener("click", openSettings);
    $("#retagSource").addEventListener("change", refreshRetagProtection);
    $("#btnSettingsSave").addEventListener("click", saveSettings);
    // Restoring defaults is two-step: a stray click must not wipe a policy the
    // operator tuned on purpose.
    let resetArmed = false;
    const disarmReset = (btn) => { resetArmed = false; btn.textContent = t("settings.reset"); btn.classList.remove("armed"); };
    $("#btnSettingsReset").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!resetArmed) {
        resetArmed = true;
        btn.textContent = t("settings.resetArm");
        btn.classList.add("armed");
        setTimeout(() => { if (resetArmed) disarmReset(btn); }, 4000);
        return;
      }
      disarmReset(btn);
      await resetSettings();
    });
    // Left-sidebar tabs: projects tree vs registry overview.
    document.querySelectorAll("#sidebarTabs .stab").forEach((b) => {
      b.addEventListener("click", () => switchTab(b.dataset.tab));
    });
    $("#btnLogs").addEventListener("click", openLogs);
    $("#btnNewProject").addEventListener("click", openCreateProject);
    $("#btnCreateProjectConfirm").addEventListener("click", submitCreateProject);
    $("#btnCleanup").addEventListener("click", openCleanup);
    $("#btnCleanupConfirm").addEventListener("click", runCleanup);
    $("#searchInput").addEventListener("input", (e) => { state.search = e.target.value; renderSidebar(); });

    $("#btnRetagConfirm").addEventListener("click", async () => {
      const repo = $("#retagRepo").value;
      const source = $("#retagSource").value;
      const target = $("#retagTarget").value.trim();
      if (!target) { toast(t("retag.target") + "?", "err"); return; }
      if (!TAG_RE.test(target)) { toast(t("retag.targetInvalid"), "err"); return; }
      if (target === source) { toast(t("retag.targetSame"), "err"); return; }

      const box = $("#retagDeleteSource");
      const deleteSource = box.checked && !box.disabled;
      const btn = $("#btnRetagConfirm");
      btn.disabled = true;
      try {
        const r = await invoke("registry/retag", {
          repository: repo, sourceTag: source, targetTag: target, deleteSource,
        });
        $("#retagModal").hidden = true;
        // The backend reports honestly when the old tag could not be dropped
        // (plain OCI v2 has no tag-scoped delete) — surface that, don't hide it.
        if (r && r.warning) toast(r.warning, "warn");
        else toast(r && r.sourceRemoved ? t("retag.renamed") : t("retag.copied"), "ok");
        invalidate(currentKey());   // this repository's listing just changed
        reloadContent();
      } catch (e) {
        toast(e.message || t("failed"), "err");
      } finally { btn.disabled = false; }
    });

    $("#btnDeleteConfirm").addEventListener("click", async () => {
      if (!pendingDelete) return;
      const btn = $("#btnDeleteConfirm");
      btn.disabled = true;
      try {
        if (state.mode === "harbor" && pendingDelete.reference) {
          const project = state.current.project;
          const short = pendingDelete.repo.replace(project + "/", "");
          await invoke("harbor/deleteTag", { project, repository: short, reference: pendingDelete.reference, tag: pendingDelete.tag });
        } else {
          // Resolve digest, then OCI delete.
          const man = await invoke("registry/manifest", { repository: pendingDelete.repo, reference: pendingDelete.tag });
          await invoke("registry/delete", { repository: pendingDelete.repo, digest: man.digest });
        }
        $("#deleteModal").hidden = true;
        toast(t("done"), "ok");
        invalidate(currentKey());   // the listing is stale the moment we delete
        reloadContent();
      } catch (e) {
        toast(e.message || t("failed"), "err");
      } finally { btn.disabled = false; pendingDelete = null; }
    });

    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { $("#" + b.dataset.close).hidden = true; }));
    document.querySelectorAll(".modal-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
