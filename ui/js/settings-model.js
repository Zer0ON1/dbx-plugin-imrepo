/* IMREPO workbench — the settings model.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /** Read the stored settings once, non-fatally, so policy markers are correct. */
  IM.preloadSettings = async function preloadSettings() {
    try {
      const set = await IM.invoke("settings/get", IM.state.connectionId ? { connectionId: IM.state.connectionId } : {});
      IM.state.settings = set.settings;
      IM.state.settingsPath = set.path || "";
      IM.state.settingsIsDefault = !!set.isDefault;
    } catch (_) { /* markers stay absent; the dialog will report the real error */ }
  }

  /* ---------- settings -------------------------------------------------------
   * Settings are stored and enforced by the backend: the sandbox has no durable
   * storage, and policy that the UI alone "remembers" is policy that can be
   * bypassed. This file keeps a draft copy so Cancel really cancels.
   * ------------------------------------------------------------------------- */

  IM.defaultSettings = function defaultSettings() {
    return {
      cleanup: { keepUntagged: 0, minAgeDays: 0, excludeRepos: [], maxReposPerScan: 100 },
      retention: { keepTagged: 0, protectTags: ["latest"] },
      scanner: { source: "harbor", threshold: "high", cacheSeconds: 300, autoScan: false, preventVul: false, scannerUuid: "" },
    };
  }

  IM.settingsOf = function settingsOf() {
    return IM.state.settings || IM.defaultSettings();
  }

  IM.draft = function draft() {
    if (!IM.state.settingsDraft) IM.state.settingsDraft = JSON.parse(JSON.stringify(IM.settingsOf()));
    return IM.state.settingsDraft;
  }

  IM.protectedPattern = function protectedPattern(tag) {
    const list = IM.settingsOf().retention.protectTags || [];
    return list.find((pat) => pat && IM.globMatch(pat, tag)) || null;
  }

  /**
   * Mirrors the backend's validation so a typo is caught before a round trip.
   * The backend still validates — this is convenience, not authority.
   */
  IM.validateDraft = function validateDraft(d) {
    const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!inRange(d.cleanup.keepUntagged, 0, 1000)) return IM.t("settings.keepUntagged");
    if (!inRange(d.cleanup.minAgeDays, 0, 3650)) return IM.t("settings.minAgeDays");
    if (!inRange(d.cleanup.maxReposPerScan, 1, 500)) return IM.t("settings.maxReposPerScan");
    if (!inRange(d.retention.keepTagged, 0, 1000)) return IM.t("settings.keepTagged");
    if (!inRange(d.scanner.cacheSeconds, 0, 86400)) return IM.t("settings.cacheSeconds");
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
})(window.IMREPO = window.IMREPO || {});
