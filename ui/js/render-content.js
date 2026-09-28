/* IMREPO workbench — the content pane.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /** Loads the project-level image overview into the content pane. */
  IM.showProjectImages = async function showProjectImages(project) {
    const seq = ++IM.state.viewSeq;
    const body = IM.$("#contentBody");
    body.innerHTML = IM.loadingHTML();
    try {
      const data = await IM.fetchCached("images", project, "", "harbor/images", { project });
      if (seq !== IM.state.viewSeq) return;   // a newer selection won
      IM.renderImagesOverview(project, data);
    } catch (e) {
      if (seq !== IM.state.viewSeq) return;
      body.innerHTML = "";
      IM.showError(e);
    }
  }

  /**
   * Project-level image overview: totals up top, then one row per image (digest).
   * Deliberately image-first — there is no tag column; tags only feed the pull /
   * layers / vuln actions and the "Tag 数" total.
   */
  IM.renderImagesOverview = function renderImagesOverview(project, data) {
    const body = IM.$("#contentBody");
    body.innerHTML = "";
    const images = (data && data.images) || [];

    const stats = IM.el("div", "img-stats");
    const stat = (label, value, strong) => {
      const c = IM.el("div", "img-stat");
      c.appendChild(IM.el("span", "k", label));
      c.appendChild(IM.el("span", "v" + (strong ? " strong" : ""), value));
      stats.appendChild(c);
    };
    stat(IM.t("imagesCount"), String(data.imageCount || 0), true);
    stat(IM.t("imagesSize"), IM.fmtSize(data.totalSize || 0), true);
    stat(IM.t("imagesRepos"), String(data.repositoryCount || 0));
    stat(IM.t("imagesTags"), String(data.tagCount || 0));
    body.appendChild(stats);

    if (data.truncated) body.appendChild(IM.el("p", "hint warn", IM.t("imagesTruncated")));
    if ((data.repositoryErrors || []).length) {
      body.appendChild(IM.el("p", "hint warn", IM.t("imagesErrors") + " (" + data.repositoryErrors.length + ")"));
    }

    if (!images.length) {
      body.appendChild(IM.el("div", "empty-state", IM.el("p", "", IM.t("noData"))));
      return;
    }

    const table = IM.el("table", "table");
    const thead = IM.el("thead");
    const hr = IM.el("tr");
    [IM.t("repo"), IM.t("digest"), IM.t("size"), IM.t("pushed"), IM.t("imagesTags"), IM.t("imagesActions")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = IM.el("tbody");
    for (const im of images) {
      const ref = (im.tags && im.tags[0]) || im.digest;
      const tr = IM.el("tr");
      // The repository name is a way in: clicking it opens that repository's
      // own listing with the full tag view.
      const tdRepo = IM.el("td");
      const link = IM.el("a", "repo-link", im.repository);
      link.href = "#";
      link.title = IM.t("imagesOpenRepo");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        IM.selectRepo({ name: project }, { name: im.repository, full_name: project + "/" + im.repository });
      });
      tdRepo.appendChild(link);
      tr.appendChild(tdRepo);
      const tdDigest = IM.el("td");
      const dg = IM.el("span", "mono digest-cell", IM.shortDigest(im.digest));
      dg.title = im.digest || "";
      tdDigest.appendChild(dg);
      if (im.type && im.type !== "IMAGE") tdDigest.appendChild(IM.el("span", "badge soft", im.type));
      tdDigest.appendChild(IM.archBadges(im.arches));
      tr.appendChild(tdDigest);
      tr.appendChild(IM.el("td", "", IM.fmtSize(im.size)));
      tr.appendChild(IM.el("td", "", IM.fmtTime(im.push_time)));
      tr.appendChild(IM.el("td", "num", String(im.tagCount || 0)));
      const tdActs = IM.el("td");
      const acts = IM.el("div", "actions");
      // Rename replaces pull/layers here: an overview row answers "what is
      // here and how old", not "how do I run this image" — the repository
      // view has the full action set.
      if ((im.tags || []).length) {
        acts.appendChild(IM.iconBtn(IM.t("retag"), "tag", () => IM.openRetag(project + "/" + im.repository, im.tags, im.tags[0])));
      }
      acts.appendChild(IM.iconBtn(IM.t("vuln"), "shield", () => IM.openVuln(project + "/" + im.repository, ref, im.digest)));
      tdActs.appendChild(acts);
      tr.appendChild(tdActs);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /** Loads a v2 namespace's overview into the content pane. */
  IM.showV2ProjectOverview = async function showV2ProjectOverview(namespace) {
    const seq = ++IM.state.viewSeq;
    const body = IM.$("#contentBody");
    body.innerHTML = IM.loadingHTML();
    try {
      const data = await IM.fetchCached("v2images", namespace, "", "registry/images", { namespace });
      if (seq !== IM.state.viewSeq) return;
      IM.renderV2ProjectOverview(namespace, data);
    } catch (e) {
      if (seq !== IM.state.viewSeq) return;
      body.innerHTML = "";
      IM.showError(e);
    }
  }

  /**
   * Namespace-level overview for a v2 registry: totals up top, then one row per
   * repository (image count, tag count, summed size). Clicking a repository opens
   * its tag listing.
   */
  IM.renderV2ProjectOverview = function renderV2ProjectOverview(namespace, data) {
    const body = IM.$("#contentBody");
    body.innerHTML = "";
    const repos = (data && data.repos) || [];

    const stats = IM.el("div", "img-stats");
    const stat = (label, value, strong) => {
      const c = IM.el("div", "img-stat");
      c.appendChild(IM.el("span", "k", label));
      c.appendChild(IM.el("span", "v" + (strong ? " strong" : ""), value));
      stats.appendChild(c);
    };
    stat(IM.t("imagesCount"), String(data.imageCount || 0), true);
    stat(IM.t("imagesSize"), IM.fmtSize(data.totalSize || 0), true);
    stat(IM.t("imagesRepos"), String(data.repoCount || 0));
    stat(IM.t("imagesTags"), String(data.tagCount || 0));
    body.appendChild(stats);

    if (data.truncated) body.appendChild(IM.el("p", "hint warn", IM.t("imagesTruncated")));
    if ((data.errors || []).length) {
      body.appendChild(IM.el("p", "hint warn", IM.t("imagesErrors") + " (" + data.errors.length + ")"));
    }
    if (!repos.length) {
      body.appendChild(IM.el("div", "empty-state", IM.el("p", "", IM.t("noData"))));
      return;
    }

    const table = IM.el("table", "table");
    const thead = IM.el("thead");
    const hr = IM.el("tr");
    [IM.t("repo"), IM.t("imagesCount"), IM.t("imagesTags"), IM.t("size")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = IM.el("tbody");
    for (const r of repos) {
      const tr = IM.el("tr");
      const tdRepo = IM.el("td");
      const link = IM.el("a", "repo-link", r.name);
      link.href = "#";
      link.title = IM.t("imagesOpenRepo");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        IM.selectRepo({ name: namespace }, { name: r.name, full_name: r.full_name || namespace + "/" + r.name });
      });
      tdRepo.appendChild(link);
      tr.appendChild(tdRepo);
      tr.appendChild(IM.el("td", "num", String(r.imageCount || 0)));
      tr.appendChild(IM.el("td", "num", String(r.tagCount || 0)));
      tr.appendChild(IM.el("td", "", IM.fmtSize(r.size)));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  IM.selectRepo = async function selectRepo(project, repo) {
    IM.state.current.project = project ? project.name : null;
    IM.state.current.repo = repo.full_name;
    IM.setCrumbs(project ? [
      { name: project.name, onClick: () => IM.goToProject(project.name) },
      { name: repo.name },
    ] : [{ name: repo.name }]);
    IM.renderSidebar();                                   // highlight + spinner slot
    // Harbor passes the repo name within its project; a v2 registry needs the
    // full namespaced path for the /v2/ endpoints.
    await IM.showRepo(project ? project.name : null,
      IM.state.mode === "harbor" ? repo.name : repo.full_name);
  }

  /**
   * Loads the artifacts/tags of one repository into the content pane.
   *
   * The sequence check is the important part: a large repository can answer long
   * after you have clicked another one, and without this guard its late response
   * would paint over the newer view — two repositories' contents ending up under
   * the name of the one clicked last.
   */
  IM.showRepo = async function showRepo(project, repo) {
    const seq = ++IM.state.viewSeq;
    const body = IM.$("#contentBody");
    body.innerHTML = IM.loadingHTML();

    try {
      if (IM.state.mode === "harbor") {
        const data = await IM.fetchArtifacts(project, repo);
        if (seq !== IM.state.viewSeq) return;             // a newer selection won
        IM.state.artifacts = data;
        IM.renderArtifactsTable(project, repo);
      } else {
        const data = await IM.fetchTags(repo);
        if (seq !== IM.state.viewSeq) return;
        IM.state.tags = data;
        IM.renderTagsTable(repo);
      }
    } catch (e) {
      if (seq !== IM.state.viewSeq) return;
      body.innerHTML = "";
      IM.showError(e);
    }
  }

  IM.showError = function showError(e) {
    const d = IM.el("div", "empty-state");
    d.appendChild(IM.el("p", "", e.message || IM.t("failed")));
    IM.$("#contentBody").appendChild(d);
  }

  /**
   * Renders the breadcrumb. Parts carry an optional onClick: a clickable segment
   * navigates back to that level. Deliberately NOT styled as a blue link — the
   * color stays exactly like the static text, an underline is the only affordance.
   */
  IM.setCrumbs = function setCrumbs(parts) {
    const c = IM.$("#crumbs");
    c.innerHTML = "";
    parts.forEach((p, i) => {
      if (i > 0) c.appendChild(IM.el("span", "sep", "/"));
      if (p.onClick) {
        const a = IM.el("a", "crumb-link", p.name);
        a.href = "#";
        a.title = p.name;
        a.addEventListener("click", (e) => { e.preventDefault(); p.onClick(); });
        c.appendChild(a);
      } else {
        const span = IM.el("span", i === parts.length - 1 ? "current" : "", p.name);
        c.appendChild(span);
      }
    });
  }

  /** A tag chip; a lock means the retention policy refuses to remove it. */
  IM.tagChip = function tagChip(name) {
    const chip = IM.el("span", "tag-chip mono", name);
    const pat = IM.protectedPattern(name);
    if (pat) {
      chip.classList.add("protected");
      chip.title = IM.t("protected.tag") + ": " + pat;
      chip.appendChild(IM.svgIcon("lock"));
    }
    return chip;
  }

  /* Architecture badges: one circle per architecture (amd64 / arm64 / …). */
  IM.archBadge = function archBadge(a) {
    const b = IM.el("span", "arch-badge mono", a);
    b.title = IM.t("arch") + ": " + a;
    return b;
  }

  IM.archBadges = function archBadges(arches) {
    const wrap = IM.el("span", "arch-badges");
    (arches || []).forEach((a) => wrap.appendChild(IM.archBadge(a)));
    return wrap;
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
  IM.deletableTag = function deletableTag(names, fallback) {
    const open = (names || []).filter((n) => !IM.protectedPattern(n));
    return open.length ? open[0] : fallback;
  }

  IM.deleteTagBtn = function deleteTagBtn(repo, tag, reference) {
    const pat = IM.protectedPattern(tag);
    const b = IM.iconBtn(
      pat ? IM.t("protected.refused") : IM.t("delete"),
      "close",
      () => {
        if (pat) { IM.toast(IM.t("protected.refused") + "  [" + pat + "]", "err"); return; }
        IM.openDelete(repo, tag, reference);
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
  IM.outOfPolicy = function outOfPolicy(arts) {
    const keep = IM.settingsOf().retention.keepTagged;
    const set = new Set();
    if (!keep) return set;
    const tagged = (arts || [])
      .filter((a) => (a.tags || []).length)
      .slice()
      .sort((a, b) => (Date.parse(b.push_time) || 0) - (Date.parse(a.push_time) || 0));
    tagged.forEach((a, i) => { if (i >= keep) set.add(a.digest); });
    return set;
  }

  IM.renderTagsTable = function renderTagsTable(repo) {
    const tags = IM.state.tags || [];
    const body = IM.$("#contentBody");
    body.innerHTML = "";
    if (!tags.length) { body.appendChild(IM.el("div", "empty-state", IM.el("p", "", IM.t("noData")))); return; }

    const table = IM.el("table", "table");
    const thead = IM.el("thead");
    const hr = IM.el("tr");
    [IM.t("tag"), IM.t("digest"), IM.t("pull"), IM.t("retag"), IM.t("layers"), IM.t("vuln"), IM.t("delete")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = IM.el("tbody");
    for (const tg of tags) {
      const tr = IM.el("tr");
      const tdTag = IM.el("td");
      tdTag.appendChild(IM.tagChip(tg));
      const archSlot = IM.el("span", "arch-badges");
      tdTag.appendChild(archSlot);
      // A v2 tag list has no digest, so it arrives with the architecture read
      // (same manifest request). The placeholder keeps the column from jumping
      // when it lands.
      const tdDigest = IM.el("td");
      const dgSpan = IM.el("span", "mono digest-cell", "—");
      tdDigest.appendChild(dgSpan);
      IM.loadTagArches(repo, tg, archSlot, dgSpan);
      const tdPull = IM.el("td");
      const pullBtn = IM.el("button", "btn btn-outline btn-sm copy-btn", IM.t("pull"));
      pullBtn.title = IM.t("pull");
      pullBtn.addEventListener("click", () => IM.openPull(repo, tg));
      tdPull.appendChild(pullBtn);
      const tdRetag = IM.el("td");
      tdRetag.appendChild(IM.iconBtn(IM.t("retag"), "tag", () => IM.openRetag(repo, [tg], tg)));
      const tdLayers = IM.el("td");
      tdLayers.appendChild(IM.iconBtn(IM.t("layers"), "layers", () => IM.openLayers(repo, tg)));
      const tdVuln = IM.el("td");
      tdVuln.appendChild(IM.iconBtn(IM.t("vuln"), "shield", () => IM.openVuln(repo, tg, null)));
      const tdDel = IM.el("td");
      tdDel.appendChild(IM.deleteTagBtn(repo, tg, null));
      tr.append(tdTag, tdDigest, tdPull, tdRetag, tdLayers, tdVuln, tdDel);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  IM.renderArtifactsTable = function renderArtifactsTable(project, repo) {
    const arts = IM.state.artifacts || [];
    const body = IM.$("#contentBody");
    body.innerHTML = "";
    if (!arts.length) { body.appendChild(IM.el("div", "empty-state", IM.el("p", "", IM.t("noData")))); return; }

    const outside = IM.outOfPolicy(arts);

    const table = IM.el("table", "table");
    const thead = IM.el("thead");
    const hr = IM.el("tr");
    [IM.t("tag"), IM.t("digest"), IM.t("size"), IM.t("pushed"), IM.t("pull"), IM.t("retag"), IM.t("layers"), IM.t("vuln"), IM.t("delete")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = IM.el("tbody");
    for (const a of arts) {
      const names = (a.tags && a.tags.length) ? a.tags.map((x) => x.name) : [];
      const tr = IM.el("tr");
      const tdTag = IM.el("td");
      if (names.length) names.forEach((n) => tdTag.appendChild(IM.tagChip(n)));
      else tdTag.appendChild(IM.el("span", "tag-chip", IM.t("untagged")));
      tdTag.appendChild(IM.archBadges(a.arches));
      // Harbor already reports the digest per artifact, so this column costs
      // nothing — unlike the v2 table, which has to read the manifest for it.
      const tdDigest = IM.el("td");
      const dg = IM.el("span", "mono digest-cell", IM.shortDigest(a.digest));
      dg.title = a.digest || "";
      tdDigest.appendChild(dg);
      // Only tagged images have a retention position; untagged ones belong to cleanup.
      if (names.length && outside.has(a.digest)) {
        const mark = IM.el("span", "badge warn-soft", IM.t("retention.outOfPolicy"));
        mark.title = IM.t("settings.keepTagged") + ": " + IM.settingsOf().retention.keepTagged;
        tdTag.appendChild(mark);
      }
      const tdSize = IM.el("td", "", IM.fmtSize(a.size));
      const tdPush = IM.el("td", "", IM.fmtTime(a.push_time));
      const tdPull = IM.el("td");
      const pullBtn = IM.el("button", "btn btn-outline btn-sm copy-btn", IM.t("pull"));
      pullBtn.addEventListener("click", () => IM.openPull(project + "/" + repo, names[0] || a.digest));
      tdPull.appendChild(pullBtn);
      const ref0 = names[0] || a.digest;
      const tdRetag = IM.el("td");
      // A retag needs a tag as its source; untagged artifacts are digest-only.
      if (names.length) tdRetag.appendChild(IM.iconBtn(IM.t("retag"), "tag", () => IM.openRetag(project + "/" + repo, names, names[0])));
      const tdLayers = IM.el("td");
      tdLayers.appendChild(IM.iconBtn(IM.t("layers"), "layers", () => IM.openLayers(project + "/" + repo, ref0)));
      const tdVuln = IM.el("td");
      tdVuln.appendChild(IM.iconBtn(IM.t("vuln"), "shield", () => IM.openVuln(project + "/" + repo, ref0, a.digest)));
      const tdDel = IM.el("td");
      if (names.length) tdDel.appendChild(IM.deleteTagBtn(project + "/" + repo, IM.deletableTag(names, names[0]), a.digest));
      tr.append(tdTag, tdDigest, tdSize, tdPush, tdPull, tdRetag, tdLayers, tdVuln, tdDel);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /**
   * Re-reads the current repository. `force` drops the cached copy first, which is
   * what the refresh button wants; switching between list and card view reuses it.
   */
  IM.reloadContent = function reloadContent(force) {
    // A project with no repository selected shows the project overview.
    if (!IM.state.current.repo && IM.state.current.project) {
      if (IM.state.mode === "harbor") {
        if (force) IM.invalidate(IM.cacheKey("images", IM.state.current.project, ""));
        IM.showProjectImages(IM.state.current.project);
      } else {
        if (force) IM.invalidate(IM.cacheKey("v2images", IM.state.current.project, ""));
        IM.showV2ProjectOverview(IM.state.current.project);
      }
      return;
    }
    if (!IM.state.current.repo) { IM.bootstrap(); return; }
    if (force) IM.invalidate(IM.currentKey());
    IM.showRepo(IM.state.mode === "harbor" ? IM.state.current.project : null,
             IM.state.mode === "harbor" ? IM.shortRepo() : IM.state.current.repo);
  }
})(window.IMREPO = window.IMREPO || {});
