/* IMREPO workbench — boot, theme, toolbar wiring.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- bootstrap ---------- */
  IM.init = async function init() {
    if (window.dbxPlugin && window.dbxPlugin.ready) {
      try { await window.dbxPlugin.ready; } catch (_) {}
    }
    if (window.dbxPlugin && window.dbxPlugin.locale) IM.locale = window.dbxPlugin.locale;
    if (IM.locale.startsWith("en")) IM.locale = "en"; else IM.locale = "zh-CN";

    IM.applyTheme();
    IM.applyI18n();
    IM.setupUI();

    const ctx = (window.dbxPlugin && window.dbxPlugin.context) || {};
    IM.state.connectionId = ctx.connectionId || (ctx.connection && ctx.connection.id) || ctx.id || null;
    if (ctx.connection) {
      IM.state.connInfo.name = ctx.connection.name || "";
      IM.state.connInfo.endpoint = ctx.connection.host || "";
    }
    if (window.dbxPlugin && window.dbxPlugin.onContext) {
      window.dbxPlugin.onContext((next) => {
        if (!next) return;
        const id = next.connectionId || (next.connection && next.connection.id);
        if (id && id !== IM.state.connectionId) {
          // Switched to another registry. Dropping the caches is not enough: the
          // tree, the breadcrumb and the content pane all still describe the
          // connection we just left, so they are emptied and the new registry is
          // bootstrapped in their place.
          IM.state.connectionId = id;
          if (next.connection) {
            IM.state.connInfo.name = next.connection.name || "";
            IM.state.connInfo.endpoint = next.connection.host || "";
          }
          IM.resetConnectionView();
          IM.bootstrap();
          return;
        }
        IM.state.connectionId = id || IM.state.connectionId;
      });
    }
    window.addEventListener("dbx-plugin-env", () => { IM.applyTheme(); });

    // Best-effort: retention markers and the cleanup dialog read these, so one
    // quiet read at startup beats a wrong first impression. Failures are
    // surfaced in the settings dialog instead of blocking the workbench.
    await IM.preloadSettings();

    await IM.bootstrap();
  }

  /**
   * Empties every view that belonged to the connection we just left.
   *
   * Nothing on screen may outlive the registry it was read from: the project
   * list, the expanded project, the breadcrumb and the content pane are all
   * "facts" about the old host, and the per-connection caches (repository
   * listings, tag architectures) hold its answers. The view sequence is bumped
   * so a response still in flight for the old host is dropped on arrival.
   */
  IM.resetConnectionView = function resetConnectionView() {
    IM.invalidate();               // repository / tag listings
    IM.archCache.clear();          // tag architectures (keyed per connection)
    IM.archInflight.clear();
    IM.state.prefetchQueue = [];
    IM.state.viewSeq++;
    IM.state.projects = [];
    IM.state.repos = [];
    IM.state.expandedProject = null;
    IM.state.reposLoading = false;
    IM.state.overview = null;
    IM.state.projectAdmin = null;
    IM.state.current = { project: null, repo: null };
    IM.state.artifacts = [];
    IM.state.tags = [];
    IM.state.sidebarTab = "projects";
    IM.state.loadingKeys.clear();
    IM.setCrumbs([]);

    const body = IM.$("#contentBody");
    body.innerHTML = "";
    const empty = IM.el("div", "empty-state");
    empty.appendChild(IM.el("p", "", IM.t("empty.title")));
    empty.appendChild(IM.el("p", "muted", IM.t("empty.sub")));
    body.appendChild(empty);

    IM.renderSidebar();
  }

  IM.applyTheme = function applyTheme() {
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

  IM.bootstrap = async function bootstrap() {
    try {
      const info = await IM.invoke("registry/info");
      if (info) {
        IM.state.connInfo.type = info.registryType || "";
        IM.state.connInfo.endpoint = info.endpoint || IM.state.connInfo.endpoint;
        IM.state.connInfo.name = info.name || IM.state.connInfo.name;
        IM.renderConnInfo();
      }
    } catch (_) { /* no active connection */ }

    // Detect Harbor vs standard registry.
    try {
      const projects = await IM.invoke("harbor/projects");
      if (Array.isArray(projects)) {
        IM.state.mode = "harbor";
        IM.state.projects = projects;
        IM.renderSidebar();
        return;
      }
    } catch (_) {}
    IM.state.mode = "docker-v2";
    await IM.loadNamespaces();
  }

  IM.renderConnInfo = function renderConnInfo() {
    IM.$(".conn-name").textContent = IM.state.connInfo.name || "—";
    IM.$(".conn-endpoint").textContent = IM.state.connInfo.endpoint || "";
    const badge = IM.$("#connType");
    badge.textContent = IM.state.connInfo.type || "registry";
  }

  IM.setupUI = function setupUI() {
    IM.$("#btnRefresh").addEventListener("click", () => IM.reloadContent(true));
    IM.$("#btnSettings").addEventListener("click", IM.openSettings);
    IM.$("#retagSource").addEventListener("change", IM.refreshRetagProtection);
    IM.$("#btnSettingsSave").addEventListener("click", IM.saveSettings);
    // Restoring defaults is two-step: a stray click must not wipe a policy the
    // operator tuned on purpose.
    let resetArmed = false;
    const disarmReset = (btn) => { resetArmed = false; btn.textContent = IM.t("settings.reset"); btn.classList.remove("armed"); };
    IM.$("#btnSettingsReset").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!resetArmed) {
        resetArmed = true;
        btn.textContent = IM.t("settings.resetArm");
        btn.classList.add("armed");
        setTimeout(() => { if (resetArmed) disarmReset(btn); }, 4000);
        return;
      }
      disarmReset(btn);
      await IM.resetSettings();
    });
    // Left-sidebar tabs: projects tree vs registry overview.
    document.querySelectorAll("#sidebarTabs .stab").forEach((b) => {
      b.addEventListener("click", () => IM.switchTab(b.dataset.tab));
    });
    IM.$("#btnLogs").addEventListener("click", IM.openLogs);
    IM.$("#btnNewProject").addEventListener("click", IM.openCreateProject);
    IM.$("#btnCreateProjectConfirm").addEventListener("click", IM.submitCreateProject);
    IM.$("#btnCleanup").addEventListener("click", IM.openCleanup);
    IM.$("#btnCleanupConfirm").addEventListener("click", IM.runCleanup);
    IM.$("#searchInput").addEventListener("input", (e) => { IM.state.search = e.target.value; IM.renderSidebar(); });

    IM.$("#btnRetagConfirm").addEventListener("click", async () => {
      const repo = IM.$("#retagRepo").value;
      const source = IM.$("#retagSource").value;
      const target = IM.$("#retagTarget").value.trim();
      if (!target) { IM.toast(IM.t("retag.target") + "?", "err"); return; }
      if (!IM.TAG_RE.test(target)) { IM.toast(IM.t("retag.targetInvalid"), "err"); return; }
      if (target === source) { IM.toast(IM.t("retag.targetSame"), "err"); return; }

      const box = IM.$("#retagDeleteSource");
      const deleteSource = box.checked && !box.disabled;
      const btn = IM.$("#btnRetagConfirm");
      btn.disabled = true;
      try {
        const r = await IM.invoke("registry/retag", {
          repository: repo, sourceTag: source, targetTag: target, deleteSource,
        });
        IM.$("#retagModal").hidden = true;
        // The backend reports honestly when the old tag could not be dropped
        // (plain OCI v2 has no tag-scoped delete) — surface that, don't hide it.
        if (r && r.warning) IM.toast(r.warning, "warn");
        else IM.toast(r && r.sourceRemoved ? IM.t("retag.renamed") : IM.t("retag.copied"), "ok");
        IM.invalidate(IM.currentKey());   // this repository's listing just changed
        IM.reloadContent();
      } catch (e) {
        IM.toast(e.message || IM.t("failed"), "err");
      } finally { btn.disabled = false; }
    });

    IM.$("#btnDeleteConfirm").addEventListener("click", async () => {
      if (!IM.pendingDelete) return;
      const btn = IM.$("#btnDeleteConfirm");
      btn.disabled = true;
      try {
        if (IM.state.mode === "harbor" && IM.pendingDelete.reference) {
          const project = IM.state.current.project;
          const short = IM.pendingDelete.repo.replace(project + "/", "");
          await IM.invoke("harbor/deleteTag", { project, repository: short, reference: IM.pendingDelete.reference, tag: IM.pendingDelete.tag });
        } else {
          // Resolve digest, then OCI delete.
          const man = await IM.invoke("registry/manifest", { repository: IM.pendingDelete.repo, reference: IM.pendingDelete.tag });
          await IM.invoke("registry/delete", { repository: IM.pendingDelete.repo, digest: man.digest });
        }
        IM.$("#deleteModal").hidden = true;
        IM.toast(IM.t("done"), "ok");
        IM.invalidate(IM.currentKey());   // the listing is stale the moment we delete
        IM.reloadContent();
      } catch (e) {
        IM.toast(e.message || IM.t("failed"), "err");
      } finally { btn.disabled = false; IM.pendingDelete = null; }
    });

    // Closing a dialog also drops its transient state, so a cancelled edit never
    // re-appears the next time the dialog is opened.
    const closeModal = (id) => {
      const modal = IM.$("#" + id);
      if (!modal) return;
      modal.hidden = true;
      if (id === "projectSettingsModal") IM.resetProjectDialogState();
    };
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
    document.querySelectorAll(".modal-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); }));
  }

/* The document may still be parsing when this file runs, so wait for the
 * DOM when needed; otherwise boot straight away. */
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", IM.init);
else IM.init();
})(window.IMREPO = window.IMREPO || {});
