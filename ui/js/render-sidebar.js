/* IMREPO workbench — the project tree.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- sidebar ---------- */
  IM.renderSidebar = function renderSidebar() {
    // Tab chrome: which tab is active, which panels are visible.
    document.querySelectorAll("#sidebarTabs .stab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === IM.state.sidebarTab);
    });
    const isOverview = IM.state.sidebarTab === "overview";
    IM.$("#sidebarSearch").hidden = isOverview;
    IM.$("#treeTitle").hidden = isOverview;
    IM.$("#tree").hidden = isOverview;
    IM.$("#overviewList").hidden = !isOverview;

    if (isOverview) {
      IM.renderOverviewList();
      return;
    }
    IM.renderTree();
  }

  /** The project tree (resources tab). */
  IM.renderTree = function renderTree() {
    const tree = IM.$("#tree");
    tree.innerHTML = "";
    const q = IM.state.search.trim().toLowerCase();

    // Both modes browse a folder-first project tree. Harbor projects come from
    // its REST API; for a plain v2 registry the projects are repository-name
    // namespaces (first path segment), loaded by loadNamespaces().
    const projects = IM.state.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    if (!projects.length) { tree.appendChild(IM.el("div", "muted", IM.t("noData"))); return; }
    for (const p of projects) {
      const item = IM.treeItem("project", "folder", p.name, p.repo_count ? String(p.repo_count) : "");
      item.addEventListener("click", () => IM.selectProject(p));
      // Per-folder settings entry: a gear on the project row, Harbor only.
      if (IM.state.mode === "harbor") {
        const gear = IM.el("span", "tree-settings");
        gear.title = IM.t("project.settings");
        gear.appendChild(IM.svgIcon("gear"));
        gear.addEventListener("click", (e) => { e.stopPropagation(); IM.openProjectSettings(p.name); });
        item.appendChild(gear);
      }
      tree.appendChild(item);
      if (IM.state.expandedProject === p.name && IM.state.reposLoading && !IM.state.repos.length) {
        const wait = IM.el("div", "tree-loading");
        wait.appendChild(IM.el("span", "spinner"));
        wait.appendChild(IM.el("span", "", IM.t("loading")));
        tree.appendChild(wait);
      }
      if (IM.state.expandedProject === p.name) {
        for (const r of IM.state.repos) {
          const key = IM.state.mode === "harbor"
            ? IM.cacheKey("artifacts", p.name, r.name)
            : IM.cacheKey("tags", null, r.full_name);
          const ri = IM.treeItem("repo", "repo", r.name, r.artifact_count ? String(r.artifact_count) : "", "lvl2", key);
          ri.addEventListener("click", () => IM.selectRepo(p, r));
          if (IM.state.current.repo === r.full_name) ri.classList.add("active");
          tree.appendChild(ri);
        }
      }
      if (IM.state.current.project === p.name && IM.state.current.repo == null) item.classList.add("active");
    }
    // Re-apply spinners: the tree was just rebuilt.
    IM.syncRowSpinners();
    IM.syncCleanupButton();   // cleanup needs Harbor + a selected project
  }

  /**
   * @param key  cache key for this row, so an in-flight fetch can show a spinner
   *             on the exact row it belongs to (click or background prefetch).
   */
  IM.treeItem = function treeItem(kind, icon, label, meta, extraCls, key) {
    const item = IM.el("div", "tree-item" + (extraCls ? " " + extraCls : ""));
    if (key) item.dataset.key = key;
    const ic = IM.el("span", "ic");
    ic.appendChild(IM.svgIcon(icon || (kind === "project" ? "folder" : "repo")));
    item.appendChild(ic);
    item.appendChild(IM.el("span", "label", label));

    const right = IM.el("div", "right");
    const spin = IM.el("span", "row-spinner");
    spin.appendChild(IM.el("span", "spinner"));
    spin.hidden = true;
    right.appendChild(spin);
    if (meta) right.appendChild(IM.el("span", "meta", meta));
    item.appendChild(right);
    return item;
  }

  IM.loadCatalog = async function loadCatalog() {
    IM.$("#tree").innerHTML = IM.loadingHTML();
    try {
      IM.state.repos = await IM.fetchCached("catalog", null, "", "registry/catalog", {});
      IM.schedulePrefetch(IM.state.repos.map((r) => ({ kind: "tags", repo: r })));
    } catch (e) {
      IM.state.repos = [];
      IM.toast(e.message || IM.t("failed"), "err");
    }
    IM.renderSidebar();
  }

  /**
   * For a plain Docker Registry v2 there is no project API — repositories are
   * grouped by their first path segment into namespaces, which the tree shows as
   * folders (exactly like Harbor projects).
   */
  IM.loadNamespaces = async function loadNamespaces() {
    IM.$("#tree").innerHTML = IM.loadingHTML();
    try {
      IM.state.projects = await IM.invoke("registry/namespaces", {});
      IM.state.repos = [];
    } catch (e) {
      IM.state.projects = [];
      IM.toast(e.message || IM.t("failed"), "err");
    }
    IM.renderSidebar();
  }

  IM.selectProject = async function selectProject(p) {
    if (IM.state.expandedProject === p.name) { IM.state.expandedProject = null; IM.state.repos = []; IM.renderSidebar(); return; }
    await IM.goToProject(p.name);
  }

  /**
   * Expands a project and shows its image overview. Shared by the sidebar click
   * and the breadcrumb: clicking the project segment of a "project / repo"
   * trail is exactly "open this project" again.
   */
  IM.goToProject = async function goToProject(name) {
    const p = IM.state.projects.find((x) => x.name === name) || { name };
    IM.state.expandedProject = p.name;
    IM.state.current.project = p.name;
    IM.state.current.repo = null;
    IM.state.repos = [];
    IM.state.reposLoading = true;
    IM.setCrumbs([{ name: p.name }]);
    IM.renderSidebar();
    if (IM.state.mode === "harbor") {
      // The project is a "folder": selecting it shows every image across the
      // project's repositories at once (image-first, no tag column), not an empty
      // pane waiting for a repository click.
      IM.showProjectImages(p.name);
      try {
        IM.state.repos = await IM.fetchCached("repos", p.name, "", "harbor/repositories", { project: p.name });
        // Warm the first few repositories so clicking one is instant rather than a
        // multi-second wait. Runs one request at a time, in the background.
        IM.schedulePrefetch(IM.state.repos.map((r) => ({ kind: "artifacts", project: p.name, repo: r.name })));
      } catch (e) {
        IM.toast(e.message || IM.t("failed"), "err");
      }
    } else {
      // A v2 namespace acts as the project: overview lists its repos/images.
      IM.showV2ProjectOverview(p.name);
      try {
        IM.state.repos = await IM.fetchCached("repos", p.name, "", "registry/repositories", { namespace: p.name });
        IM.schedulePrefetch(IM.state.repos.map((r) => ({ kind: "tags", repo: r.full_name })));
      } catch (e) {
        IM.toast(e.message || IM.t("failed"), "err");
      }
    }
    IM.state.reposLoading = false;
    IM.renderSidebar();
  }

  IM.syncCleanupButton = function syncCleanupButton() {
    const btn = IM.$("#btnCleanup");
    if (!btn) return;
    const harbor = IM.state.mode === "harbor";
    const hasProject = !!IM.state.current.project;
    btn.disabled = !(harbor && hasProject);
    btn.title = !harbor ? IM.t("cleanup.needHarbor") : hasProject ? IM.t("cleanup.title") : IM.t("cleanup.needProject");
    // Harbor-only toolbar actions: a plain v2 registry has no project creation
    // or audit-log API, so those buttons are hidden rather than shown dead.
    const np = IM.$("#btnNewProject");
    if (np) np.hidden = !harbor;
    const lg = IM.$("#btnLogs");
    if (lg) lg.hidden = !harbor;
  }
})(window.IMREPO = window.IMREPO || {});
