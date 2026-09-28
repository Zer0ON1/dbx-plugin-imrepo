/* ---------------------------------------------------------------------------
 * Preview mock — injected into a generated copy of ui/index.html by
 * tools/make-preview.py. NEVER hand-maintain the surrounding HTML: the whole
 * point of generating the harness is that the markup always matches the real
 * workbench (a hand-copied harness once drifted and produced a false negative).
 *
 * What it does, in order:
 *   1. mimics the DBX host: injects the same Tailwind v4 design tokens the host
 *      copies into the sandbox — including the hostile --color-muted: #f5f5f5,
 *      a muted SURFACE that is unusable as text. A host-proof palette stays
 *      legible here.
 *   2. stubs window.dbxPlugin with representative data so the real workbench
 *      scripts (ui/js/*.js) run unmodified.
 *   3. drives the UI into a state worth screenshotting.
 *
 * Supported query params:
 *   theme=light|dark   appearance to emulate
 *   mode=harbor|docker Harbor project tree vs plain OCI catalog
 *   modal=retag|layers|vuln|delete   open a dialog on the first table row
 *   probe=1            mirror the RPC log into a hidden #__probe element
 *   switchconn=1       announce a connection switch mid-session (onContext);
 *                      noredrill=1 keeps the old view on screen to inspect it
 *   slowarches=ms      delay registry/arches, to exercise the request dedup
 * ------------------------------------------------------------------------- */
(function () {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const openModal = params.get("modal") || "";
  const mode = params.get("mode") === "docker" ? "docker" : "harbor";
  // Concurrency harness: delay one repository's listing so a second click lands
  // while it is still in flight (?slowrepo=name&slowms=2000&race=name).
  const slowRepo = params.get("slowrepo") || "";
  const slowMs = Number(params.get("slowms") || 2500);
  const raceRepo = params.get("race") || "";
  /* Settings scenario knobs, so screenshots and tests can drive the panel into
     a state that matters without editing this file. */
  const keepUntagged = Number(params.get("keepuntagged") || 0);
  const minAgeDays = Number(params.get("minage") || 0);
  const keepTagged = Number(params.get("keeptagged") || 0);
  const protectTags = (params.get("protect") || "latest").split(",").filter(Boolean);
  const threshold = params.get("threshold") || "high";
  const scannerSource = params.get("scannersource") || "harbor";
  const withRules = params.get("rules") === "1";   // cleanups carry rule decisions
  // Delay registry/arches so a second render of the same repository lands while
  // the first read is still in flight (exercises the in-flight dedup).
  const slowArches = Number(params.get("slowarches") || 0);
  // The host notifies the workbench of a connection switch through the callback
  // registered in onContext; kept here so a driver can fire it.
  let ctxCb = null;

  /* --- 1. emulate the host's inline token injection ---------------------- */
  const HOST_TOKENS = {
    "--color-background": theme === "dark" ? "rgb(10 10 10)" : "rgb(255 255 255)",
    "--color-foreground": theme === "dark" ? "rgb(250 250 250)" : "rgb(10 10 10)",
    "--color-card": theme === "dark" ? "rgb(23 23 23)" : "rgb(255 255 255)",
    "--color-card-foreground": theme === "dark" ? "rgb(250 250 250)" : "rgb(10 10 10)",
    "--color-popover": theme === "dark" ? "rgb(23 23 23)" : "rgb(255 255 255)",
    "--color-popover-foreground": theme === "dark" ? "rgb(250 250 250)" : "rgb(10 10 10)",
    "--color-primary": theme === "dark" ? "rgb(250 250 250)" : "rgb(23 23 23)",
    "--color-primary-foreground": theme === "dark" ? "rgb(23 23 23)" : "rgb(250 250 250)",
    "--color-secondary": "rgb(245 245 245)",
    "--color-secondary-foreground": "rgb(23 23 23)",
    "--color-muted": theme === "dark" ? "rgb(38 38 38)" : "rgb(245 245 245)",
    "--color-muted-foreground": theme === "dark" ? "rgb(161 161 161)" : "rgb(115 115 115)",
    "--color-accent": "rgb(245 245 245)",
    "--color-accent-foreground": "rgb(23 23 23)",
    "--color-destructive": "rgb(231 0 11)",
    "--color-border": theme === "dark" ? "rgb(38 38 38)" : "rgb(229 229 229)",
    "--color-input": "rgb(229 229 229)",
    "--color-ring": "rgb(161 161 161)",
    "--color-surface": theme === "dark" ? "rgb(23 23 23)" : "rgb(245 245 245)",
    "--color-hover": theme === "dark" ? "rgb(38 38 38)" : "rgb(240 240 240)",
    "--radius": "0.625rem",
    "--radius-sm": "0.375rem",
    "--font-sans": "'Inter', sans-serif",
    "--font-mono": "'JetBrains Mono', monospace",
  };
  const root = document.documentElement;
  root.dataset.dbxTheme = theme;
  for (const [k, v] of Object.entries(HOST_TOKENS)) root.style.setProperty(k, v);

  /* --- 2. stub the bridge with representative data ----------------------- */
  const MB = 1024 * 1024;
  const PROJECTS = [
    { name: "ai", repo_count: 1 }, { name: "ai-agent", repo_count: 1 },
    { name: "checkout", repo_count: 5 }, { name: "payments", repo_count: 14 },
    { name: "base", repo_count: 3 }, { name: "court", repo_count: 2 },
    { name: "ddf", repo_count: 6 }, { name: "sandbox", repo_count: 2 },
  ];
  const REPOS = [
    { name: "ledger-api", full_name: "payments/ledger-api", artifact_count: 5 },
    { name: "settlement-api", full_name: "payments/settlement-api", artifact_count: 4 },
    { name: "docs-api", full_name: "payments/docs-api", artifact_count: 7 },
    { name: "audit-api", full_name: "payments/audit-api", artifact_count: 12 },
    { name: "policy-api", full_name: "payments/policy-api", artifact_count: 3 },
    { name: "report-api", full_name: "payments/report-api", artifact_count: 9 },
    { name: "assistant-api", full_name: "payments/assistant-api", artifact_count: 6 },
    { name: "auth-api", full_name: "payments/auth-api", artifact_count: 21 },
    { name: "gateway", full_name: "payments/gateway", artifact_count: 11 },
  ];

  // A v2 registry has a flat catalog; namespaces are the first path segment.
  const V2_CATALOG = [
    "team-alpha/app", "team-alpha/db", "team-alpha/worker",
    "team-beta/web", "team-beta/api",
    "shared/base", "shared/runner",
    "nginx",
  ];
  const V2_NAMESPACES = (() => {
    const m = {};
    for (const r of V2_CATALOG) {
      const ns = r.includes("/") ? r.split("/")[0] : r;
      m[ns] = (m[ns] || 0) + 1;
    }
    return Object.keys(m).sort().map((n) => ({ name: n, repo_count: m[n] }));
  })();
  const v2Repo = (full) => {
    const ns = full.includes("/") ? full.split("/")[0] : full;
    return { name: full.includes("/") ? full.slice(ns.length + 1) : full, full_name: full };
  };
  const ARTIFACTS = [
    { digest: "sha256:8f2c41ab90de", size: 821 * MB, push_time: "2026-09-22T14:18:36Z", tags: [{ name: "2026-09-22_141718" }, { name: "v1.0.0" }] },
    { digest: "sha256:7a1b33cd22ea", size: 821 * MB, push_time: "2026-09-22T09:55:57Z", tags: [{ name: "2026-09-22_095415" }] },
    { digest: "sha256:51de90aa71c3", size: 821 * MB, push_time: "2026-09-18T17:02:14Z", tags: [{ name: "2026-09-18_179161" }] },
    { digest: "sha256:33b7e2f4a08c", size: 821 * MB, push_time: "2026-09-18T16:57:59Z", tags: [{ name: "2026-09-18_165645" }] },
    { digest: "sha256:10ac77d5b934", size: 412 * MB, push_time: "2026-09-18T16:54:40Z", tags: [] },
  ];
  // Project-level overview: one image per row across several repositories, with
  // totals derived from the rows so they can never drift apart.
  const IMG = (repo, hex, sizeMB, push, tags, type) => ({
    repository: repo, digest: "sha256:" + hex.padEnd(64, hex.split("").reverse().join("")),
    type: type || "IMAGE", size: sizeMB * MB, push_time: push, tags,
    arches: ["amd64", "arm64"],
    tagCount: tags.length,
  });
  const PROJECT_IMAGES = {
    project: "payments",
    repositoryCount: 9,
    truncated: false,
    images: [
      IMG("ledger-api", "8f2c41ab90de", 821, "2026-09-22T14:18:36Z", ["2026-09-22_141718", "v1.0.0"]),
      IMG("ledger-api", "7a1b33cd22ea", 821, "2026-09-22T09:55:57Z", ["2026-09-22_095415"]),
      IMG("settlement-api", "51de90aa71c3", 604, "2026-09-21T17:02:14Z", ["2026-09-21_170214"]),
      IMG("audit-api", "33b7e2f4a08c", 412, "2026-09-20T16:57:59Z", ["v2.1.0"]),
      IMG("auth-api", "10ac77d5b934", 388, "2026-09-19T16:54:40Z", ["latest", "v1.4.2"]),
      IMG("docs-api", "2b6f3e91dd02", 233, "2026-09-18T08:11:02Z", ["2026-09-18_081102"]),
      IMG("report-api", "6d1c0b5a77f0", 156, "2026-09-17T19:22:10Z", ["v3.0.0"]),
      IMG("gateway", "9e3a2d4c81bb", 96, "2026-09-16T11:05:33Z", ["2026-09-16_110533"]),
      IMG("docs-api", "44aa55bb66cc", 78, "2026-09-15T10:00:00Z", []),
      IMG("ledger-api", "c0ffee000011", 64, "2026-09-14T09:00:00Z", ["old"], "CHART"),
    ],
  };
  PROJECT_IMAGES.imageCount = PROJECT_IMAGES.images.length;
  PROJECT_IMAGES.tagCount = PROJECT_IMAGES.images.reduce((n, i) => n + i.tagCount, 0);
  PROJECT_IMAGES.totalSize = PROJECT_IMAGES.images.reduce((n, i) => n + i.size, 0);

  const VULNS = {
    severity: "High",
    vulnerabilities: [
      { severity: "Critical", id: "CVE-2024-21626", package: "runc", version: "1.1.9-0ubuntu1" },
      { severity: "High", id: "CVE-2024-24790", package: "net/http", version: "1.21.5" },
      { severity: "High", id: "CVE-2023-44487", package: "golang.org/x/net", version: "0.17.0" },
      { severity: "Medium", id: "CVE-2024-28180", package: "openssl", version: "3.0.2-0ubuntu1.15" },
      { severity: "Low", id: "CVE-2024-2511", package: "openssl", version: "3.0.2-0ubuntu1.15" },
    ],
  };
  // Mirrors what the backend returns for a real BuildKit image: 1-based indexes,
  // compressed layer sizes straight from the manifest, one dominant layer.
  const LAYERS = {
    platform: { os: "linux", architecture: "amd64" },
    digest: "sha256:8f2c41ab90de1e4f9b7c2a5d8e3f0b1c2d3e4f5a",
    totalSize: 373136384,
    layers: [
      { index: 1, command: "ADD ubuntu-jammy.tar.gz / # buildkit", size: 78346240, digest: "sha256:aa11bb22cc33" },
      { index: 2, command: "RUN /bin/sh -c apt-get update && apt-get install -y ca-certificates", size: 43127808, digest: "sha256:dd44ee55ff66" },
      { index: 3, command: "COPY /workspace/out/ledger-api /app/bin/app", size: 251658240, digest: "sha256:7711aa22bb33" },
      { index: 4, command: "ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", size: 4096, digest: "sha256:0001aa22bb33" },
      { index: 5, command: "ENTRYPOINT [\"/app/bin/app\"]", size: 0, digest: "sha256:0002cc33dd44" },
    ],
  };
  /* Request log, mirrored into a hidden #__probe element so a headless test can
     assert what the workbench actually asked for (prefetch, cache hits, races). */
  const reqLog = [];
  /** Mirrors the log into the DOM (the headless test reads it back from there). */
  function pushProbe() {
    if (!params.get("probe")) return;
    let probe = document.getElementById("__probe");
    if (!probe) {
      probe = document.createElement("div");
      probe.id = "__probe";
      probe.style.display = "none";
      document.body.appendChild(probe);
    }
    probe.textContent = reqLog.join(",");
  }
  function recordRequest(method, repo) {
    reqLog.push(repo ? method + ":" + repo : method);
    pushProbe();
  }

  /* Surface uncaught errors in the DOM: a headless dump cannot read the console,
     and a silently half-rendered panel is undiagnosable without this. */
  const errBox = document.createElement("pre");
  errBox.id = "__jserr";
  errBox.style.display = "none";
  window.addEventListener("error", (e) => {
    errBox.textContent += "JSERR: " + e.message + " @ " + (e.filename || "").split("/").pop() + ":" + e.lineno + "\n";
    document.body.appendChild(errBox);
  });
  window.addEventListener("unhandledrejection", (e) => {
    errBox.textContent += "REJECTION: " + (e.reason && (e.reason.stack || e.reason.message || e.reason)) + "\n";
    document.body.appendChild(errBox);
  });

  const RESPONSES = {
    "registry/info": { registryType: mode === "docker" ? "docker-v2" : "harbor", endpoint: "https://harbor.example.com", name: "IMREPO" },
    "harbor/projects": PROJECTS,
    "harbor/repositories": REPOS,
    "harbor/artifacts": ARTIFACTS,
    "harbor/images": PROJECT_IMAGES,
    "harbor/vulnerabilities": {
      ...VULNS,
      // The panel now renders the threshold decision the backend computed.
      threshold, counts: { Critical: 1, High: 2, Medium: 3, Low: 1 },
      highest: "Critical", exceedsThreshold: threshold !== "critical",
      source: "harbor", scanner: "Trivy", cached: params.get("cached") === "1",
      generatedAt: "2026-09-23T09:12:04Z",
    },
    "app/info": {
      pluginId: "com.leavingrain.imrepo", version: "0.1.0", protocolVersion: 1,
      transport: "stdio-jsonl",
      // Mirrors the backend, which now always reports the project page. A fork
      // that has not set one sends "" — the About panel renders a placeholder
      // rather than a dead link — so ?nogithub=1 keeps that branch reachable.
      github: params.get("nogithub") ? "" : "https://github.com/Zer0ON1/dbx-plugin-imrepo",
      settingsPath: "/home/dev/.config/imrepo-dbx-plugin/settings.json",
    },
    "harbor/scannerInfo": {
      available: true,
      scanners: [
        { uuid: "uuid-trivy", name: "Trivy", is_default: true, health: "healthy" },
        { uuid: "uuid-anchore", name: "Anchore", is_default: false, health: "healthy" },
      ],
      project: { name: "payments", scannerUuid: "", autoScan: false, preventVul: false, severity: "low" },
      notes: params.get("scannernotes") === "1" ? ["could not list scanners: 403 Forbidden"] : [],
    },
    "harbor/applyScanner": { ok: true, applied: ["auto_scan=true"], message: "Applied to Harbor project payments: auto_scan=true" },
    "harbor/scan": { ok: true, message: "Scan requested" },
    "harbor/projectAdmin": {
      project: { projectId: 7, name: "payments", public: false, retentionId: 12,
                 metadata: { auto_scan: "false", severity: "low", retention_id: "12" } },
      members: [
        { id: 11, entity_name: "admin", entity_type: "u", role_id: 1, role_name: "projectAdmin" },
        { id: 12, entity_name: "developer1", entity_type: "u", role_id: 2, role_name: "developer" },
        { id: 13, entity_name: "qa-guest", entity_type: "u", role_id: 3, role_name: "guest" },
      ],
      retention: {
        id: 12, algorithm: "or",
        rules: [
          { id: 1, template: "latestPushedK", params: { latestPushedK: 10 },
            tag_selectors: [{ kind: "doublestar", decoration: "matches", pattern: "**" }],
            scope_selectors: { repository: [{ kind: "doublestar", decoration: "repoMatches", pattern: "**" }] } },
        ],
        trigger: { kind: "Schedule", settings: { cron: "0 0 2 * * *" } },
        scope: { level: "project", ref: 7 },
      },
      users: [
        { user_id: 1, username: "admin", email: "admin@example.com", sysadmin_flag: true },
        { user_id: 2, username: "developer1", email: "dev1@example.com", sysadmin_flag: false },
        { user_id: 3, username: "qa-guest", email: "qa@example.com", sysadmin_flag: false },
        { user_id: 4, username: "robot$cicd", email: "", sysadmin_flag: false },
      ],
    },
    "harbor/users": [
      { user_id: 1, username: "admin", email: "admin@example.com", sysadmin_flag: true },
      { user_id: 2, username: "developer1", email: "dev1@example.com", sysadmin_flag: false },
      { user_id: 3, username: "qa-guest", email: "qa@example.com", sysadmin_flag: false },
    ],
    "harbor/projectSetPublic": { ok: true, public: true },
    "harbor/memberAdd": { ok: true },
    "harbor/memberRole": { ok: true },
    "harbor/memberRemove": { ok: true },
    "harbor/retentionSave": { ok: true, retentionId: 12 },
    "harbor/userAdmin": { ok: true },
    "harbor/userCreate": { ok: true },
    "harbor/userPassword": { ok: true },
    "harbor/userDelete": { ok: true },
    "harbor/currentUser": {
      admin: params.get("meadmin") !== "0",
      user: params.get("meadmin") === "0"
        ? { user_id: 2, username: "developer1", email: "dev1@example.com", sysadmin_flag: false }
        : { user_id: 1, username: "admin", email: "admin@example.com", sysadmin_flag: true },
    },
    "registry/layers": LAYERS,
    "registry/catalog": mode === "docker" ? V2_CATALOG : REPOS.map((r) => r.full_name),
    "registry/namespaces": V2_NAMESPACES,
    "registry/overview": {
      namespaceCount: V2_NAMESPACES.length,
      repoCount: V2_CATALOG.length,
      imageCount: 28, tagCount: 47,
      totalSize: 63 * 1024 * 1024 * 1024,
      sizeByNamespace: [
        { name: "team-alpha", size: 40 * 1024 * 1024 * 1024 },
        { name: "team-beta", size: 15 * 1024 * 1024 * 1024 },
        { name: "shared", size: 7 * 1024 * 1024 * 1024 },
        { name: "nginx", size: 1 * 1024 * 1024 * 1024 },
      ],
      namespaces: V2_NAMESPACES,
      truncated: false, errors: [],
    },
    "registry/tags": ["2026-09-22_141718", "2026-09-22_095415", "2026-09-18_179161"],
    "registry/retag": { ok: true, sourceTag: "2026-09-22_141718", targetTag: "v1.0.1", sourceRemoved: true },
    "harbor/untagged": {
      // `rules=1` shows what the backend sends once cleanup rules are configured:
      // protected rows stay visible, with the reason, but cannot be selected.
      items: [
        { repository: "ledger-api", digest: "sha256:" + "a1".repeat(32), size: 812 * MB, push_time: "2026-09-18T16:54:40Z" },
        { repository: "ledger-api", digest: "sha256:" + "b2".repeat(32), size: 604 * MB, push_time: "2026-09-18T16:57:59Z",
          ...(withRules ? { protected: true, protectedReason: "inside the 1 newest untagged artifacts that are kept" } : {}) },
        { repository: "settlement-api", digest: "sha256:" + "c3".repeat(32), size: 233 * MB, push_time: "2026-09-12T08:11:02Z" },
        { repository: "docs-api", digest: "sha256:" + "d4".repeat(32), size: 78 * MB, push_time: "2026-08-30T19:22:10Z",
          ...(withRules ? { protected: true, protectedReason: "repository is excluded by rule \"doc-*\"" } : {}) },
      ],
      scannedRepositories: 9, totalRepositories: 9, truncated: false,
      totalSize: (812 + 604 + 233 + 78) * MB,
      ...(withRules ? {
        rules: { keepUntagged: 1, minAgeDays: 7, excludeRepos: ["doc-*"], maxReposPerScan: 100 },
        protectedCount: 2, eligibleCount: 2, eligibleSize: (812 + 233) * MB,
      } : {}),
    },
    "harbor/cleanupUntagged": {
      ok: true, deletedCount: 4, reclaimedBytes: (812 + 604 + 233 + 78) * MB,
      deleted: [], skipped: [], failed: [],
    },
    "harbor/projectCreate": { ok: true, name: "new-project", public: false },
    "harbor/quotaGet": { project: "payments", quotaId: 42, hardBytes: -1, usedBytes: 214643506 },
    "harbor/quotaSet": { ok: true, hardBytes: -1 },
    // Enough rows to overflow the dialog: a real page holds up to pageSize of
    // them, and the reported symptom — rows showing through the sticky header —
    // only appears once the body actually scrolls.
    "harbor/logs": {
      logs: Array.from({ length: 40 }, (_, i) => {
        const ops = ["pull", "push", "create", "delete", "update"];
        const repos = ["auth-api", "gateway", "docs-api", "audit-api", "policy-api"];
        const users = ["admin", "ci-robot", "developer1"];
        return {
          time: new Date(Date.UTC(2026, 8, 23, 12, 0, 0) - i * 3600e3).toISOString(),
          operation: ops[i % ops.length],
          resource: `payments/${repos[i % repos.length]}:v1.${i}.0`,
          username: users[i % users.length],
          // Every other row belongs to the other project, so a scope filter that
          // does nothing is visible as "the same rows either way".
          // 7 = payments (the project the dialog opens scoped to), 5 = another.
          // Weighted so the DEFAULT view is long enough to scroll: the sticky
          // header can only be exercised by content that actually overflows.
          project_id: i % 4 === 3 ? 5 : 7,
        };
      }),
      page: 1, pageSize: 50,
    },
    "harbor/overview": {
      projectCount: 8, repoCount: 27, imageCount: 143, totalSize: 96724217856,
      pullCounts: { "1": 12, "3": 47, "7": 128 }, pullTruncated: false,
      projectErrors: [],
      recentProjects: [
        { name: "payments", created: "2026-09-22T09:00:00Z" },
        { name: "court", created: "2026-09-20T11:00:00Z" },
        { name: "ddf", created: "2026-09-18T15:30:00Z" },
      ],
      topPulled: [
        { name: "payments", pulls: 41 },
        { name: "ai", pulls: 23 },
        { name: "base", pulls: 15 },
      ],
      sizeByProject: [
        { name: "payments", size: 78 * 1024 * 1024 * 1024 },
        { name: "checkout", size: 9 * 1024 * 1024 * 1024 },
        { name: "ddf", size: 3 * 1024 * 1024 * 1024 },
      ],
    },
    "settings/getProject": { project: "payments", connectionId: "preview-conn", scanner: { source: scannerSource, threshold, cacheSeconds: 300, autoScan: false, preventVul: false, scannerUuid: "" }, isDefault: false },
    "settings/setProject": { project: "payments", connectionId: "preview-conn", message: "Project settings saved" },
  };
  const DEFAULTS = {
    cleanup: { keepUntagged: 0, minAgeDays: 0, excludeRepos: [], maxReposPerScan: 100 },
    retention: { keepTagged: 0, protectTags: ["latest"] },
    scanner: { source: "harbor", threshold: "high", cacheSeconds: 300, autoScan: false, preventVul: false, scannerUuid: "" },
  };
  let saved = {
    cleanup: { keepUntagged, minAgeDays, excludeRepos: (params.get("excluderepos") || "").split(",").filter(Boolean), maxReposPerScan: 100 },
    retention: { keepTagged, protectTags },
    scanner: { source: scannerSource, threshold, cacheSeconds: 300, autoScan: false, preventVul: false, scannerUuid: "" },
  };

  window.dbxPlugin = {
    ready: Promise.resolve(),
    locale: "zh-CN",
    context: { connectionId: "preview-conn", connection: { id: "preview-conn" } },
    theme: { appearance: theme, tokens: HOST_TOKENS },
    onContext(cb) { ctxCb = cb; },
    invoke: async (method, p) => {
      // One tag's architectures are identified by repository AND tag, so the log
      // keeps both — a repo-only entry cannot tell three tags apart.
      recordRequest(method, method === "registry/arches"
        ? `${(p && p.repository) || ""}@${(p && p.reference) || ""}`
        : (p && p.repository) || "");
      // A registry without the Harbor API makes the workbench fall back to plain
      // OCI v2.
      if (method === "harbor/projects" && mode === "docker") throw new Error("404 page not found");
      if (method === "harbor/artifacts") {
        const name = (p && p.repository) || "";
        if (slowRepo && name.startsWith(slowRepo)) {
          await new Promise((r) => setTimeout(r, slowMs));
        }
        // Tags are prefixed with the repository name so a test can tell whose
        // listing is on screen.
        return [0, 1, 2].map((i) => ({
          digest: ("sha256:" + name + i).padEnd(24, "0"),
          size: (100 + i) * 1024 * 1024,
          push_time: "2026-09-22T14:18:36Z",
          tags: [{ name: `${name}-${i + 1}` }],
          // The backend computes `arches` from the references below and sends
          // both — the tag table reads `arches`. This fixture used to carry only
          // the raw references, exactly as the backend did, which is why the
          // missing badges went unnoticed: mock and reality were wrong together.
          //
          // The third row deliberately has neither. That is what a single-arch
          // image, or an older Harbor, looks like — and its badges must still
          // appear, read from the manifest instead of the list payload.
          ...(i === 2 ? {} : {
            arches: ["amd64", "arm64"],
            references: [
              { child_digest: "sha256:x" + i + "amd64", platform: { architecture: "amd64", os: "linux" } },
              { child_digest: "sha256:x" + i + "arm64", platform: { architecture: "arm64", os: "linux" } },
            ],
          }),
        }));
      }
      // Settings round-trip: the harness keeps a copy so the modal shows what was
      // saved, and the policy markers downstream match.
      if (method === "harbor/logs") {
        const all = RESPONSES["harbor/logs"].logs;
        // This mock stands in for the sidecar, so it receives what the UI sends
        // — a project NAME — and has to resolve it the way the backend does
        // (ProjectDetail). Filtering here on the backend's internal `q` parameter
        // would test nothing: the UI never sends it.
        const name = (p && p.project) || "";
        const pid = name ? (RESPONSES["harbor/projectAdmin"].project.projectId) : null;
        const rows = pid ? all.filter((l) => l.project_id === pid) : all;
        return { logs: rows, page: 1, pageSize: 50 };
      }
      if (method === "harbor/userAdmin") {
        // Flip the fixture, not just acknowledge: the panel re-reads the user
        // list after the write, and a mock that always answered "ok" without
        // changing anything would let a broken refresh pass unnoticed.
        const u = (RESPONSES["harbor/users"] || []).find((x) => x.user_id === (p && p.userId));
        if (u) u.sysadmin_flag = !!(p && p.admin);
        return { ok: true };
      }
      if (method === "settings/get") {
        return { settings: JSON.parse(JSON.stringify(saved)), connectionId: "preview-conn",
                 isDefault: false, path: RESPONSES["app/info"].settingsPath };
      }
      if (method === "settings/set") {
        saved = JSON.parse(JSON.stringify(p.settings));
        return { settings: JSON.parse(JSON.stringify(saved)), connectionId: "preview-conn",
                 path: RESPONSES["app/info"].settingsPath, message: "Settings saved" };
      }
      if (method === "settings/reset") {
        saved = JSON.parse(JSON.stringify(DEFAULTS));
        return { settings: JSON.parse(JSON.stringify(saved)), connectionId: "preview-conn",
                 message: "Settings reset to defaults" };
      }
      // v2 namespace browsing: repository list and namespace overview derive from
      // the RPC's namespace argument (the URL query `namespace` is unrelated).
      if (method === "registry/repositories") {
        const ns = (p && p.namespace) || "";
        return V2_CATALOG
          .filter((r) => (r.includes("/") ? r.split("/")[0] : r) === ns)
          .map(v2Repo);
      }
      if (method === "registry/images") {
        const ns = (p && p.namespace) || "team-alpha";
        const reps = (ns === "team-alpha")
          ? [ { name: "app", imageCount: 4, tagCount: 6, size: 520 * MB },
              { name: "db", imageCount: 2, tagCount: 3, size: 310 * MB },
              { name: "worker", imageCount: 3, tagCount: 5, size: 280 * MB } ]
          : [ { name: "main", imageCount: 2, tagCount: 4, size: 214 * MB } ];
        const repos = reps.map((r) => ({ ...r, full_name: ns + "/" + r.name }));
        return { namespace: ns, repoCount: repos.length,
          imageCount: repos.reduce((n, r) => n + r.imageCount, 0),
          tagCount: repos.reduce((n, r) => n + r.tagCount, 0),
          totalSize: repos.reduce((n, r) => n + r.size, 0),
          repos, truncated: false, errors: [] };
      }
      if (method === "registry/arches") {
        if (slowArches) await new Promise((r) => setTimeout(r, slowArches));
        // The digest rides along with the architectures: a v2 tags/list has no
        // digest, and the tag table shows one, so the backend answers both from
        // the manifest read it was already doing.
        const ref = (p && p.reference) || "";
        return { repository: (p && p.repository) || "", reference: ref,
                 digest: "sha256:" + ref.padEnd(8, "0") + "c0ffee".repeat(10),
                 arches: ["amd64", "arm64"] };
      }
      if (!(method in RESPONSES)) throw new Error("no mock for " + method);
      return JSON.parse(JSON.stringify(RESPONSES[method]));
    },
  };

  /* --- 3. drive the UI --------------------------------------------------- */
  const byText = (text, cls) => [...document.querySelectorAll(".tree-item" + (cls ? "." + cls : ""))]
    .find((n) => n.textContent.includes(text));

  window.addEventListener("load", () => {
    if (mode === "docker") {
      // docker-v2 tree: namespaces are folders. Open the first namespace, then
      // its first repository (poll — the repo row appears once the namespace's
      // listing resolves). ?overview=1 keeps the namespace selected instead.
      setTimeout(() => document.querySelector("#tree .tree-item")?.click(), 200);
      if (!params.get("overview")) {
        const openRepo = () => {
          const repo = document.querySelector("#tree .tree-item.lvl2");
          if (repo) repo.click();
          else setTimeout(openRepo, 100);
        };
        setTimeout(openRepo, 500);
      }
    } else {
      setTimeout(() => byText("payments")?.click(), 150);
      // ?overview=1 keeps the project selected (shows the project-wide image
      // overview) instead of drilling into one repository.
      if (!params.get("overview")) {
        setTimeout(() => byText("ledger-api", "lvl2")?.click(), 500);
      }
    }
    if (false) setTimeout(() => document.getElementById("btnCards")?.click(), 800); // cards view removed in v1.5.0
    if (raceRepo) {
      // Click the slow repository, then a fast one while it is still loading.
      setTimeout(() => byText(raceRepo, "lvl2")?.click(), 700);
      setTimeout(() => byText("audit-api", "lvl2")?.click(), 1100);
    }
    if (params.get("revisit")) {
      // Leave the repository the driver opened, then come back to it. The second
      // visit is a cache hit, which is where the architecture badges used to
      // disappear: a cache hit resolves without suspending, so the paint ran
      // before the caller had attached the slot it was painting into.
      setTimeout(() => byText("docs-api", "lvl2")?.click(), 700);
      setTimeout(() => byText("ledger-api", "lvl2")?.click(), 1600);
    }
    if (params.get("collapsethenopen")) {
      // The reported sequence: open a project (its images are listed on the
      // right), collapse the project in the tree, then click a repository in the
      // content pane. The tree must expand again — the highlighted row lives
      // inside the project, so a collapsed tree hid it completely.
      setTimeout(() => byText("payments")?.click(), 1400);   // collapse
      setTimeout(() => document.querySelector("#contentBody .repo-link")?.click(), 2200);
    }
    const clickRepo = params.get("clickrepo");
    if (clickRepo) {
      // Click a repository long after the background prefetch has finished, so a
      // second request for it would mean the cache missed.
      setTimeout(() => byText(clickRepo, "lvl2")?.click(), 4000);
    }
    if (params.get("switchconn")) {
      // The host announces a switch by invoking the callback the workbench left in
      // onContext. It fires once the first drill-down has painted, so the test can
      // tell "the old view was dropped" apart from "it never rendered".
      setTimeout(() => {
        if (!ctxCb) { document.documentElement.dataset.probeSwitch = "nohandler"; return; }
        // The marker goes in first: the workbench starts re-reading synchronously
        // inside the callback, so everything logged after this point belongs to
        // the new connection.
        reqLog.push("ctx:switch");
        pushProbe();
        document.documentElement.dataset.probeSwitch = "1";
        ctxCb({ connectionId: "preview-conn-2",
                connection: { id: "preview-conn-2", name: "IMREPO-2", host: "https://harbor-dr.example.com" } });
        if (params.get("noredrill")) return;
        // Re-open the first project/namespace and its first repository on the new
        // connection: the workbench must have re-bootstrapped for this to work.
        const openProject = () => {
          const row = document.querySelector("#tree .tree-item");
          if (row) row.click(); else setTimeout(openProject, 100);
        };
        const openRepo = () => {
          const row = document.querySelector("#tree .tree-item.lvl2");
          if (row) row.click(); else setTimeout(openRepo, 100);
        };
        setTimeout(openProject, 300);
        setTimeout(openRepo, 700);
      }, 1500);
    }
    if (params.get("reclick")) {
      // Click the same repository again while its architecture reads are still in
      // flight (?slowarches=ms): the second render must join the pending reads
      // instead of issuing one more request per tag.
      const again = () => {
        const row = document.querySelector("#tree .tree-item.lvl2");
        if (row) row.click();
        else setTimeout(again, 100);
      };
      setTimeout(again, 600);
    }
    if (params.get("projectsettings")) {
      // Open the per-folder settings dialog for the first project.
      setTimeout(() => document.querySelector(".tree-item .tree-settings")?.click(), 800);
      if (params.get("armapply")) {
        // Flip the first policy switch (autoScan), then arm the two-step apply.
        setTimeout(() => {
          const sw = document.querySelectorAll("#projectSettingsBody .set-switch input")[0];
          if (sw) { sw.checked = true; sw.dispatchEvent(new Event("change", { bubbles: true })); }
          setTimeout(() => document.getElementById("btnApplyScanner")?.click(), 500);
        }, 1600);
      }
    }
    if (params.get("scrollcontent")) {
      // Scroll the content pane so the sticky table header can be verified.
      setTimeout(() => {
        const b = document.getElementById("contentBody");
        if (b) b.scrollTop = 70;
      }, 1200);
    }
    if (params.get("overviewtab")) {
      // Switch to the left-sidebar "总览" tab.
      setTimeout(() => {
        [...document.querySelectorAll("#sidebarTabs .stab")]
          .find((b) => b.dataset.tab === "overview")?.click();
        if (params.get("overviewlink")) {
          setTimeout(() => {
            [...document.querySelectorAll("#overviewList .ov-project-link")][0]?.click();
          }, 500);
        }
      }, 800);
    }
    const logScope = params.get("logscope");
    if (logScope) {
      // Pick the project in the scope selector once the dialog has rendered.
      setTimeout(() => {
        const sel = document.querySelector("#logsBody .logs-bar select");
        if (!sel) return;
        // "all" means the empty option (the dialog opens scoped to the current
        // project by design, so "" is the explicit way back to everything).
        sel.value = logScope === "all" ? "" : logScope;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, 1400);
    }
    if (params.get("openlogs")) setTimeout(() => {
      document.getElementById("btnLogs")?.click();
      if (params.get("logscroll")) {
        // Scroll the dialog so the sticky header is exercised: the reported
        // symptom was rows visible through it.
        setTimeout(() => {
          const b = document.getElementById("logsBody");
          if (!b) return;
          b.scrollTop = Number(params.get("logscroll"));
          if (!params.get("stickycheck")) return;
          // Measure how far the sticky header sits below the scroll container's
          // top edge once the body is scrolled. A positive gap is the container
          // padding left uncovered, with scrolled-past rows showing through it.
          const th = b.querySelector("th");
          if (!th) { document.documentElement.dataset.stickyGap = "no-th"; return; }
          const tbl = b.querySelector("table");
          const d = document.documentElement.dataset;
          d.stickyGap = String(Math.round(th.getBoundingClientRect().top - b.getBoundingClientRect().top));
          // Diagnostics, so a surprising number can be explained instead of guessed.
          d.stickyInfo = [
            "scrollTop=" + Math.round(b.scrollTop),
            "pad=" + getComputedStyle(b).paddingTop,
            "barH=" + Math.round((b.querySelector(".logs-bar") || {getBoundingClientRect: () => ({height: 0})}).getBoundingClientRect().height),
            "tableTopRel=" + (tbl ? Math.round(tbl.getBoundingClientRect().top - b.getBoundingClientRect().top) : "n/a"),
            "thPos=" + getComputedStyle(th).position,
            "thTopCss=" + getComputedStyle(th).top,
            "rows=" + b.querySelectorAll("tbody tr").length,
          ].join(" ");
        }, 900);
      }
    }, 800);
    if (params.get("newproject")) setTimeout(() => document.getElementById("btnNewProject")?.click(), 800);
    if (openModal) setTimeout(() => {
      // Cleanup lives in the content toolbar, not in a row.
      if (openModal === "cleanup") {
        document.getElementById("btnCleanup")?.click();
        if (params.get("uncheckall")) {
          // Exercise the confirm gate: no selection must mean no deletion.
          setTimeout(() => {
            const all = document.getElementById("cleanupAll");
            if (!all) { document.documentElement.dataset.probeUncheck = "missing"; return; }
            all.checked = false;
            all.dispatchEvent(new Event("change"));
            // Marker so a test can tell "the driver ran" apart from "nothing happened".
            document.documentElement.dataset.probeUncheck = "1";
          }, 700);
        }
        return;
      }
      if (openModal === "settings") {
        document.getElementById("btnSettings")?.click();
        const toggles = Number(params.get("admintoggles") || 0);
        if (toggles) {
          // Click the admin switch on a non-self row, several times, waiting long
          // enough between hits for each re-render to land.
          setTimeout(() => {
            const sw = [...document.querySelectorAll("#settingsBody .user-box .set-switch input")]
              .filter((el) => !el.disabled);
            if (!sw.length) { document.documentElement.dataset.probeToggle = "missing"; return; }
            let n = 0;
            const hit = () => {
              sw[n % sw.length].checked = !sw[n % sw.length].checked;
              sw[n % sw.length].dispatchEvent(new Event("change", { bubbles: true }));
              n += 1;
              if (n < toggles) setTimeout(hit, 700);
            };
            hit();
          }, 900);
        }
        if (params.get("dirty")) {
          setTimeout(() => {
            const inp = document.querySelector("#settingsBody .set-input");
            if (!inp) { document.documentElement.dataset.probeDirty = "missing"; return; }
            inp.value = String(Number(inp.value || 0) + 3);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            document.documentElement.dataset.probeDirty = "1";
          }, 400);
        }
        if (params.get("armapply")) {
          setTimeout(() => {
            const sw = document.querySelectorAll("#settingsBody .set-switch input")[0];
            if (sw) { sw.checked = true; sw.dispatchEvent(new Event("change", { bubbles: true })); }
            setTimeout(() => document.getElementById("btnApplyScanner")?.click(), 200);
          }, 500);
        }
        if (params.get("confirmsave")) {
          setTimeout(() => document.getElementById("btnSettingsSave")?.click(), 700);
        }
        if (params.get("scroll") === "bottom") {
          setTimeout(() => {
            const b = document.getElementById("settingsBody");
            if (b) b.scrollTop = b.scrollHeight;
          }, 800);
        }
        return;
      }
      // Table: pull is a labelled button, the rest are icon buttons in this order.
      if (openModal === "pull") {
        document.querySelector("tbody tr .copy-btn")?.click();
        return;
      }
      const btns = document.querySelector("tbody tr")?.querySelectorAll(".icon-btn");
      if (!btns || !btns.length) return;
      const order = { retag: 0, layers: 1, vuln: 2 }; // per-row action order
      if (openModal in order) btns[Math.min(order[openModal], btns.length - 1)].click();
      else if (openModal === "delete") btns[btns.length - 1].click();
      // Layers dialog: [0] = as built, [1] = by size.
      if (openModal === "layers" && params.get("layersort") === "size") {
        setTimeout(() => document.querySelectorAll("#layersBody .layer-toolbar .btn")[1]?.click(), 1400);
      }
    }, 1000);
  });
})();
