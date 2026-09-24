/* IMREPO workbench — the registry overview.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- registry-wide overview (left-sidebar tab) ---------- */

  /** Switch the left-sidebar tab. */
  IM.switchTab = function switchTab(tab) {
    IM.state.sidebarTab = tab;
    IM.renderSidebar();
    if (tab === "overview") {
      // The overview is its own view: a stale project/repo trail would point
      // nowhere from here.
      IM.setCrumbs([{ name: IM.t("ov.title") }]);
      IM.renderOverviewPane();
    }
  }

  /**
   * Fetches the registry overview once and caches it. The sidebar tab renders
   * the two project lists; the content pane renders the totals. Clicking a
   * project link jumps to the projects tab and expands that project.
   */
  IM.ensureOverview = async function ensureOverview() {
    if (IM.state.overview) return IM.state.overview;
    IM.state.overview = await IM.invoke(IM.state.mode === "harbor" ? "harbor/overview" : "registry/overview", {});
    return IM.state.overview;
  }

  IM.renderOverviewList = async function renderOverviewList() {
    const box = IM.$("#overviewList");
    box.innerHTML = IM.loadingHTML();
    let o;
    try {
      o = await IM.ensureOverview();
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
      return;
    }
    box.innerHTML = "";
    const linkList = (title, items, key) => {
      box.appendChild(IM.el("div", "ov-sec-title", IM.t(title)));
      if (!items.length) {
        box.appendChild(IM.el("p", "muted", IM.t("noData")));
        return;
      }
      for (const it of items) {
        const a = IM.el("a", "ov-project-link", it.name);
        a.href = "#";
        a.title = it.name;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          IM.openProjectFromOverview(it.name);
        });
        box.appendChild(a);
      }
    };
    linkList("ov.recent", o.recentProjects || []);
    linkList("ov.topPulled", o.topPulled || []);
    if (IM.state.mode !== "harbor") {
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
  IM.openProjectFromOverview = function openProjectFromOverview(name) {
    IM.state.sidebarTab = "projects";
    IM.renderSidebar();
    IM.goToProject(name);
  }

  /** The content pane for the overview tab: the four totals + pull window. */
  IM.renderOverviewPane = function renderOverviewPane() {
    const body = IM.$("#contentBody");
    body.innerHTML = IM.loadingHTML();
    IM.ensureOverview().then((o) => {
      body.innerHTML = "";
      body.appendChild(IM.el("h2", "pane-title", IM.t("ov.title")));
      const stats = IM.el("div", "img-stats");
      const stat = (label, value, strong) => {
        const c = IM.el("div", "img-stat");
        c.appendChild(IM.el("span", "k", label));
        c.appendChild(IM.el("span", "v" + (strong ? " strong" : ""), value));
        stats.appendChild(c);
      };
      stat(IM.t("ov.projects"), String(o.projectCount != null ? o.projectCount : o.namespaceCount || 0), true);
      stat(IM.t("ov.repos"), String(o.repoCount || 0));
      stat(IM.t("ov.images"), String(o.imageCount || 0), true);
      stat(IM.t("ov.size"), IM.fmtSize(o.totalSize || 0), true);
      body.appendChild(stats);

      if (IM.state.mode === "harbor") {
        // Pull window: all three counts arrive in one payload, so switching the
        // window never costs another request.
        const row = IM.el("div", "ov-pull-row");
        row.appendChild(IM.el("span", "k", IM.t("ov.pulls")));
        const seg = IM.el("div", "seg");
        [1, 3, 7].forEach((d) => {
          const b = IM.el("button", "btn btn-sm" + (IM.state.overviewWindow === d ? " seg-on" : " btn-ghost"),
            IM.t("ov.days").replace("{n}", String(d)));
          b.addEventListener("click", () => { IM.state.overviewWindow = d; IM.renderOverviewPane(); });
          seg.appendChild(b);
        });
        row.appendChild(seg);
        row.appendChild(IM.el("span", "v strong", String((o.pullCounts || {})[String(IM.state.overviewWindow)] || 0)));
        body.appendChild(row);
        if (o.pullTruncated) body.appendChild(IM.el("p", "hint", IM.t("ov.truncated")));
      }

      // Charts: storage distribution always; Harbor adds most-pulled projects.
      if (IM.state.mode === "harbor") {
        body.appendChild(IM.hBarChart(IM.t("ov.topPulled"),
          (o.topPulled || []).map((p) => ({ label: p.name, value: p.pulls })), (v) => String(v)));
      }
      const sizeItems = IM.state.mode === "harbor" ? (o.sizeByProject || []) : (o.sizeByNamespace || []);
      body.appendChild(IM.hBarChart(IM.t(IM.state.mode === "harbor" ? "ov.sizeByProject" : "ov.sizeByNamespace"),
        sizeItems.map((p) => ({ label: p.name, value: p.size })), IM.fmtSize));

      if (o.truncated) body.appendChild(IM.el("p", "hint", IM.t("ov.truncated")));
      const errs = o.projectErrors || o.errors || [];
      if (errs.length) {
        const p = IM.el("p", "hint warn", IM.t("ov.errors") + " (" + errs.length + ")");
        p.title = errs.join("\n");
        body.appendChild(p);
      }
    }).catch((e) => {
      body.innerHTML = "";
      body.appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
    });
  }

  /**
   * A horizontal bar chart rendered as inline SVG. Items are {label, value};
   * `fmt` turns a value into its display string. Pure SVG + textContent, so no
   * HTML injection and no external chart library in the sandbox.
   */
  IM.hBarChart = function hBarChart(title, items, fmt) {
    const card = IM.el("div", "ov-chart");
    card.appendChild(IM.el("div", "ov-chart-title", title));
    const rows = (items || []).filter((i) => (Number(i.value) || 0) > 0).slice(0, 8);
    if (!rows.length) {
      card.appendChild(IM.el("p", "muted", IM.t("noData")));
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
})(window.IMREPO = window.IMREPO || {});
