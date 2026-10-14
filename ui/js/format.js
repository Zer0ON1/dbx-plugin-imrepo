/* IMREPO workbench — formatting and matching helpers.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.fmtSize = function fmtSize(bytes) {
    if (bytes == null) return "—";
    const n = Number(bytes) || 0;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + units[i];
  }

  IM.fmtTime = function fmtTime(s) {
    if (!s) return "—";
    const d = new Date(s);
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleString(IM.locale === "zh-CN" ? "zh-CN" : "en-US", { hour12: false });
  }

  IM.shortDigest = (d) => (d && d.length > 24 ? d.slice(0, 24) + "…" : (d || "—"));

  /* ---------- modals & events ---------- */
  /**
   * Drops a leading "<project>/" from a repository name.
   *
   * Only the prefix: `String.replace(project + "/", "")` removes the first
   * occurrence anywhere, which is the same thing for a well-formed name and the
   * wrong thing for a name that merely contains the project string later on.
   * Repository names may themselves contain slashes (Harbor allows nested
   * repositories such as "kylin/kylin-server-minimal"), so prefix-only is the
   * only correct reading.
   */
  IM.stripProjectPrefix = function stripProjectPrefix(name, project) {
    const r = name || "";
    return project && r.startsWith(project + "/") ? r.slice(project.length + 1) : r;
  }

  IM.shortRepo = function shortRepo() {
    return IM.stripProjectPrefix(IM.state.current.repo, IM.state.current.project);
  }

  /* ---------- pull commands ---------- */
  IM.registryHost = function registryHost() {
    const ep = (IM.state.connInfo.endpoint || "").trim();
    return ep ? ep.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  }

  /**
   * Glob matching for UI hints only — the backend decides for real. Mirrors
   * path.Match closely enough to warn before a click turns into an error.
   */
  IM.globMatch = function globMatch(pattern, value) {
    const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    try { return new RegExp("^" + esc + "$", "i").test(String(value)); } catch (_) { return false; }
  }

  IM.SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

  IM.severityRank = (v) => IM.SEV_RANK[String(v || "").trim().toLowerCase()] || 0;
})(window.IMREPO = window.IMREPO || {});
