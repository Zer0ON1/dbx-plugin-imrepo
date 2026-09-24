/* IMREPO workbench — backend calls, caching and prefetching.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.invoke = async function invoke(method, params = {}) {
    const p = { ...params };
    if (IM.state.connectionId && !p.connectionId) p.connectionId = IM.state.connectionId;
    return await window.dbxPlugin.invoke(method, p, { timeoutMs: 90000 });
  }

  /* ---------- cached, deduplicated loading ---------- */
  IM.cacheKey = function cacheKey(kind, project, repo) {
    return [kind, IM.state.mode, project || "", repo || ""].join("|");
  }

  IM.setLoading = function setLoading(key, on) {
    if (!key) return;
    if (on) IM.state.loadingKeys.add(key);
    else IM.state.loadingKeys.delete(key);
    IM.syncRowSpinners();
  }

  /** Paints/clears the little spinner on every sidebar row that is being fetched. */
  IM.syncRowSpinners = function syncRowSpinners() {
    document.querySelectorAll(".tree-item[data-key]").forEach((node) => {
      const spin = node.querySelector(".row-spinner");
      if (spin) spin.hidden = !IM.state.loadingKeys.has(node.dataset.key);
    });
  }

  IM.invalidate = function invalidate(key) {
    if (key) IM.state.cache.delete(key);
    else IM.state.cache.clear();
  }

  /**
   * Fetches through the cache. Concurrent calls for the same repository share one
   * request, which matters because a click can land while a prefetch is running.
   */
  IM.fetchCached = function fetchCached(kind, project, repo, method, params) {
    const key = IM.cacheKey(kind, project, repo);
    const hit = IM.state.cache.get(key);
    if (hit && Date.now() - hit.at < IM.CACHE_TTL_MS) return Promise.resolve(hit.data);
    if (IM.state.inflight.has(key)) return IM.state.inflight.get(key);

    IM.setLoading(key, true);
    const p = IM.invoke(method, params)
      .then((data) => {
        IM.state.cache.set(key, { data, at: Date.now() });
        return data;
      })
      .finally(() => {
        IM.state.inflight.delete(key);
        IM.setLoading(key, false);
      });
    IM.state.inflight.set(key, p);
    return p;
  }

  IM.fetchArtifacts = (project, repo) =>
    IM.fetchCached("artifacts", project, repo, "harbor/artifacts", { project, repository: repo });

  IM.fetchTags = (repo) =>
    IM.fetchCached("tags", null, repo, "registry/tags", { repository: repo });

  IM.currentKey = function currentKey() {
    if (!IM.state.current.repo) return null;
    return IM.state.mode === "harbor"
      ? IM.cacheKey("artifacts", IM.state.current.project, IM.shortRepo())
      : IM.cacheKey("tags", null, IM.state.current.repo);
  }

  /**
   * Warms repository listings in the background so a click is instant instead of
   * a multi-second wait. Runs strictly one at a time — the goal is to remove the
   * wait, not to hammer the registry with a burst of parallel scans.
   */
  IM.schedulePrefetch = function schedulePrefetch(jobs) {
    const wanted = jobs.slice(0, IM.PREFETCH_LIMIT).filter((j) => {
      const key = IM.cacheKey(j.kind, j.project, j.repo);
      const hit = IM.state.cache.get(key);
      return !(hit && Date.now() - hit.at < IM.CACHE_TTL_MS);
    });
    // Newest project wins: drop whatever was queued for a project you left.
    IM.state.prefetchQueue = wanted;
    if (!IM.state.prefetching) IM.runPrefetch();
  }

  IM.runPrefetch = async function runPrefetch() {
    IM.state.prefetching = true;
    try {
      while (IM.state.prefetchQueue.length) {
        const job = IM.state.prefetchQueue.shift();
        try {
          if (job.kind === "artifacts") await IM.fetchArtifacts(job.project, job.repo);
          else await IM.fetchTags(job.repo);
        } catch (_) {
          /* Prefetch failures stay silent — clicking the row reports them. */
        }
      }
    } finally {
      IM.state.prefetching = false;
    }
  }

  /**
   * Cache key for one tag's architectures. The connection id is part of it: the
   * same repository path exists in every registry, and without it a switch to
   * another connection served registry A's platforms for registry B's image.
   */
  IM.archCacheKey = function archCacheKey(repo, tag) {
    return (IM.state.connectionId || "") + "|" + repo + "|" + tag;
  }

  IM.loadTagArches = async function loadTagArches(repo, tag, slot) {
    const key = IM.archCacheKey(repo, tag);
    let arches = IM.archCache.get(key);
    if (!arches) {
      // Two table rows (or a re-render landing while the first read is still in
      // flight) share one request instead of issuing two.
      let p = IM.archInflight.get(key);
      if (!p) {
        p = IM.invoke("registry/arches", { repository: repo, reference: tag })
          .then((r) => (r && r.arches) || [])
          .catch(() => [])
          .then((list) => {
            IM.archCache.set(key, list);
            IM.archInflight.delete(key);
            return list;
          });
        IM.archInflight.set(key, p);
      }
      arches = await p;
    }
    if (arches.length && slot.isConnected) {
      slot.innerHTML = "";
      (arches || []).forEach((a) => slot.appendChild(IM.archBadge(a)));
    }
  }
})(window.IMREPO = window.IMREPO || {});
