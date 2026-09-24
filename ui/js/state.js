/* IMREPO workbench — shared mutable state.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.state = {
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
    /* Transient project-settings dialog state (see IM.resetProjectDialogState):
     * the two-step apply switches and the Harbor-side sync marker. Reset on every
     * open and close of that dialog, never carried across it. */
    applyArmed: false,
    applySeverity: false,
    liveSynced: false,
    // Sequence guards, one per dialog that fetches on open: a slow answer must
    // not paint into a dialog that has since been pointed at something else.
    vulnSeq: 0,
    vulnRef: null,
    layersSeq: 0,
    cleanupSeq: 0,
  };

  IM.CACHE_TTL_MS = 60_000;   // stale enough to be free, fresh enough to trust

  IM.PREFETCH_LIMIT = 6;      // repositories warmed per project

  /* A v2 tag list carries no platform info, so each tag's architectures are
   * fetched lazily (one cheap manifest read) and painted into place. The slot
   * itself is the .arch-badges container — badges are dropped straight in,
   * never nested inside another wrapper.
   *
   * Keyed per connection (see IM.archCacheKey): an architecture belongs to one
   * registry, so a repo|tag key alone would hand registry B the answer read from
   * registry A. `archInflight` dedupes concurrent reads of the same key. Both are
   * dropped when the host switches connection. */
  IM.archCache = new Map();
  IM.archInflight = new Map();

  IM.locale = "zh-CN";

  IM.pendingDelete = null;

  /* ---------- untagged artifact cleanup (PRD 2.4) ----------
   * Read-only scan → explicit list with sizes → confirmation → deletion.
   * The backend re-checks every target is still untagged right before deleting,
   * so a digest that gained a tag while the dialog was open is skipped. */
  IM.pendingCleanup = null;

  IM.layerOrder = "index"; // "index" (as built) | "size" (largest first)
})(window.IMREPO = window.IMREPO || {});
