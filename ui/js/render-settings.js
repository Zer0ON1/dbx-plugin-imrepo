/* IMREPO workbench — the settings dialog and its form controls.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- settings form building blocks ---------- */

  IM.setSection = function setSection(titleKey, descKey, badgeKey) {
    const sec = IM.el("section", "set-section");
    const head = IM.el("div", "set-head");
    head.appendChild(IM.el("h4", "", IM.t(titleKey)));
    if (badgeKey) head.appendChild(IM.el("span", "badge soft", IM.t(badgeKey)));
    sec.appendChild(head);
    if (descKey) sec.appendChild(IM.el("p", "set-desc", IM.t(descKey)));
    return sec;
  }

  /** A label/help block on the left, the control on the right. */
  IM.setRow = function setRow(sec, labelKey, helpKey, control) {
    const row = IM.el("div", "set-row");
    const left = IM.el("div", "set-label");
    left.appendChild(IM.el("div", "lab", IM.t(labelKey)));
    if (helpKey) left.appendChild(IM.el("div", "help", IM.t(helpKey)));
    row.appendChild(left);
    const box = IM.el("div", "set-control");
    box.appendChild(control);
    row.appendChild(box);
    sec.appendChild(row);
    return row;
  }

  IM.numberControl = function numberControl(value, min, max, onChange) {
    const inp = IM.el("input", "set-input");
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

  IM.selectControl = function selectControl(value, options, onChange) {
    const sel = IM.el("select", "set-select");
    options.forEach((o) => {
      const opt = IM.el("option", "", o.label);
      opt.value = o.value;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  IM.switchControl = function switchControl(checked, onChange) {
    const wrap = IM.el("label", "set-switch");
    const box = IM.el("input");
    box.type = "checkbox";
    box.checked = !!checked;
    box.addEventListener("change", () => onChange(box.checked));
    wrap.appendChild(box);
    wrap.appendChild(IM.el("span", "track"));
    return wrap;
  }

  /* ---------- settings dialog ---------- */

  IM.openSettings = async function openSettings() {
    IM.state.settingsDraft = null;
    IM.state.settingsDirty = false;
    IM.$("#settingsModal").hidden = false;
    IM.$("#settingsBody").innerHTML = IM.loadingHTML();
    const btn = IM.$("#btnSettingsSave");
    btn.textContent = IM.t("settings.save");

    let set = null;
    try {
      set = await IM.invoke("settings/get", IM.state.connectionId ? { connectionId: IM.state.connectionId } : {});
      IM.state.settings = set.settings;
      IM.state.settingsPath = set.path || "";
      IM.state.settingsIsDefault = !!set.isDefault;
    } catch (e) {
      IM.$("#settingsBody").innerHTML = "";
      IM.$("#settingsBody").appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
      // Saving from here would write defaults over the stored settings, so the
      // action is closed off until a reload succeeds.
      btn.disabled = true;
      return;
    }
    btn.disabled = false;

    if (!IM.state.appInfo) {
      try { IM.state.appInfo = await IM.invoke("app/info", {}); } catch (_) { IM.state.appInfo = {}; }
    }
    IM.renderSettings();
  }

  IM.renderSettings = function renderSettings() {
    const d = IM.draft();
    const body = IM.$("#settingsBody");
    body.innerHTML = "";

    /* scope banner: whose settings these are */
    const scope = IM.el("div", "set-scope");
    const who = IM.state.connInfo.name
      ? IM.state.connInfo.name + (IM.state.connInfo.endpoint ? " · " + IM.state.connInfo.endpoint : "")
      : IM.t("settings.defaults");
    scope.appendChild(IM.el("span", "set-who", who));
    scope.appendChild(IM.el("span", "set-scope-note", IM.t("settings.scope")));
    if (IM.state.settingsIsDefault) scope.appendChild(IM.el("span", "badge soft", IM.t("settings.defaults")));
    const dirtyHint = IM.el("span", "set-dirty", IM.t("settings.dirty"));
    dirtyHint.id = "settingsDirtyHint";
    dirtyHint.hidden = !IM.state.settingsDirty;
    scope.appendChild(dirtyHint);
    body.appendChild(scope);
    if (!IM.state.connectionId) body.appendChild(IM.el("p", "hint warn", IM.t("settings.noConnection")));

    /* The per-folder cleanup/retention policies live in each project's settings
       dialog, and since v1.5.0 so does vulnerability scanning — configured per
       project. The global panel keeps the account-level sections only. */
    /* 4 — user management (Harbor admin) */
    if (IM.state.mode === "harbor") {
      const secU = IM.setSection("user.manage", null);
      secU.appendChild(IM.el("div", "set-sub", IM.t("user.manage")));
      body.appendChild(secU);
      IM.renderUserManagement(secU);
    }

    /* 5 — registry garbage collection (Harbor admin) */
    if (IM.state.mode === "harbor") {
      const secG = IM.setSection("gc.title", "gc.desc");
      body.appendChild(secG);
      IM.renderGCSection(secG);
    }

    /* 6 — about */
    body.appendChild(IM.renderAbout());
  }

  /**
   * The Harbor-side half of the scanner section: what the server currently has,
   * and the values this plugin would write. Kept visually separate because it
   * changes the registry, while everything above only changes local policy.
   *
   * Since v1.5.0 this lives in the per-project settings dialog and edits the
   * project-scanner draft (state.projectScannerDraft), not the global one.
   */
  IM.renderHarborScanPolicy = function renderHarborScanPolicy(d) {
    const project = IM.state.projectAdmin ? IM.state.projectAdmin.project : IM.state.current.project;
    const rerender = () => IM.renderProjectSettings(project, IM.state.projectAdmin.data);
    const wrap = IM.el("div", "set-live");
    wrap.appendChild(IM.el("div", "set-sub", IM.t("settings.live")));

    if (IM.state.mode !== "harbor") {
      wrap.appendChild(IM.el("p", "hint", IM.t("settings.notHarbor")));
      return wrap;
    }
    if (!project) {
      wrap.appendChild(IM.el("p", "hint", IM.t("settings.noProject")));
      return wrap;
    }
    if (IM.state.scannerError) {
      wrap.appendChild(IM.el("p", "hint warn", IM.t("settings.loadFailed") + ": " + IM.state.scannerError));
      return wrap;
    }
    const info = IM.state.scannerInfo;
    if (!info) { wrap.appendChild(IM.el("p", "hint", IM.t("settings.loadFailed"))); return wrap; }

    const live = info.project || {};
    const scanners = info.scanners || [];
    // Harbour's own values seed the draft once per open. Re-syncing on every
    // repaint would undo pending edits when the apply button re-renders.
    if (!IM.state.liveSynced) {
      d.scannerUuid = live.scannerUuid || "";
      d.autoScan = !!live.autoScan;
      d.preventVul = !!live.preventVul;
      IM.state.liveSynced = true;
    }

    /* what Harbor has right now */
    const now = IM.el("div", "live-grid");
    const addFact = (k, v) => {
      const cell = IM.el("div", "live-cell");
      cell.appendChild(IM.el("span", "k", k));
      cell.appendChild(IM.el("span", "v", v || "—"));
      now.appendChild(cell);
    };
    const currentScanner = scanners.find((x) => x.uuid === live.scannerUuid);
    addFact(IM.t("settings.projectScanner"),
      live.scannerUuid ? (currentScanner ? currentScanner.name : live.scannerUuid) : IM.t("settings.projectScanner.follow"));
    addFact(IM.t("settings.autoScan"), String(!!live.autoScan));
    addFact(IM.t("settings.preventVul"), String(!!live.preventVul));
    addFact("severity", live.severity || "—");
    if (scanners.length) {
      const names = scanners.map((x) => x.name + (x.is_default ? " (default)" : "")).join(" · ");
      addFact(IM.t("settings.scanners"), names);
    }
    wrap.appendChild(now);

    /* what this plugin would write */
    const options = [];
    // "Follow the system default" is only offered when that is already the case:
    // unsetting a pinned scanner is not something this plugin can do reliably.
    if (!live.scannerUuid) options.push({ value: "", label: IM.t("settings.projectScanner.follow") });
    scanners.forEach((x) => options.push({ value: x.uuid, label: x.name }));
    if (!options.length) options.push({ value: live.scannerUuid || "", label: live.scannerUuid || IM.t("settings.projectScanner.follow") });
    // Any change here must repaint: the pending summary and the apply button are
    // derived from these values, so without a repaint the button would stay
    // disabled and the edit would look ignored.
    const onHarborChange = (apply) => {
      apply();
      IM.state.applyArmed = false;
      rerender();
    };
    IM.setRow(wrap, "settings.projectScanner", null,
      IM.selectControl(d.scannerUuid || "", options,
        (v) => onHarborChange(() => { d.scannerUuid = v; })));
    IM.setRow(wrap, "settings.autoScan", null,
      IM.switchControl(d.autoScan, (v) => onHarborChange(() => { d.autoScan = v; })));
    IM.setRow(wrap, "settings.preventVul", null,
      IM.switchControl(d.preventVul, (v) => onHarborChange(() => { d.preventVul = v; })));
    IM.setRow(wrap, "settings.severityOnHarbor", null,
      IM.switchControl(IM.state.applySeverity, (v) => onHarborChange(() => { IM.state.applySeverity = v; })));

    const pending = IM.pendingApply();
    if (pending.items.length) {
      wrap.appendChild(IM.el("p", "hint", IM.t("settings.applyHint")
        .replace("{project}", project)
        .replace("{items}", pending.items.join(", "))));
    } else {
      wrap.appendChild(IM.el("p", "hint", IM.t("settings.applyNothing")));
    }

    const apply = IM.el("button", "btn btn-outline btn-sm", IM.state.applyArmed ? IM.t("settings.applyArm") : IM.t("settings.apply"));
    apply.id = "btnApplyScanner";
    if (!pending.items.length) apply.disabled = true;
    if (IM.state.applyArmed) apply.className = "btn btn-danger btn-sm";
    apply.addEventListener("click", async () => {
      // Two steps on purpose: this writes to the registry, not to local prefs.
      if (!IM.state.applyArmed) { IM.state.applyArmed = true; rerender(); return; }
      apply.disabled = true;
      try {
        const r = await IM.invoke("harbor/applyScanner", Object.assign({ project }, pending.payload));
        IM.toast((r && r.message) || IM.t("settings.applied"), "ok");
        IM.state.applyArmed = false;
        IM.state.liveSynced = false;
        IM.state.scannerInfo = await IM.invoke("harbor/scannerInfo", { project });
        rerender();
      } catch (e) {
        apply.disabled = false;
        IM.state.applyArmed = false;
        IM.toast(e.message || IM.t("failed"), "err");
        rerender();
      }
    });
    wrap.appendChild(IM.el("div", "set-actions", apply));

    const notes = info.notes || [];
    if (notes.length) {
      const ul = IM.el("ul", "set-notes");
      notes.forEach((nt) => ul.appendChild(IM.el("li", "", nt)));
      wrap.appendChild(IM.el("div", "set-sub", IM.t("settings.notes")));
      wrap.appendChild(ul);
    }
    return wrap;
  }

  /** Only the differences get written, so applying is never a blind overwrite. */
  IM.pendingApply = function pendingApply() {
    const s = IM.state.projectScannerDraft || {};
    const live = (IM.state.scannerInfo && IM.state.scannerInfo.project) || {};
    const items = [];
    const payload = {};
    if (live.scannerUuid !== undefined && (s.scannerUuid || "") !== (live.scannerUuid || "")) {
      payload.scannerUuid = s.scannerUuid || "";
      const chosen = (IM.state.scannerInfo.scanners || []).find((x) => x.uuid === s.scannerUuid);
      items.push(IM.t("settings.projectScanner") + " → " + (chosen ? chosen.name : (s.scannerUuid || IM.t("settings.projectScanner.follow"))));
    }
    if (live.autoScan !== undefined && !!s.autoScan !== !!live.autoScan) {
      payload.autoScan = !!s.autoScan;
      items.push("auto_scan → " + String(!!s.autoScan));
    }
    if (live.preventVul !== undefined && !!s.preventVul !== !!live.preventVul) {
      payload.preventVul = !!s.preventVul;
      items.push("prevent_vul → " + String(!!s.preventVul));
    }
    if (IM.state.applySeverity && (live.severity || "").toLowerCase() !== s.threshold) {
      payload.severity = s.threshold;
      items.push("severity → " + s.threshold);
    }
    return { payload, items };
  }

  IM.renderAbout = function renderAbout() {
    const info = IM.state.appInfo || {};
    const sec = IM.setSection("settings.about", null);
    const grid = IM.el("div", "set-about");
    const line = (k, vEl) => {
      const row = IM.el("div", "about-row");
      row.appendChild(IM.el("span", "k", k));
      const v = IM.el("span", "v");
      v.appendChild(vEl);
      row.appendChild(v);
      grid.appendChild(row);
    };
    line(IM.t("settings.version"), IM.el("span", "mono", info.version || "—"));
    line(IM.t("settings.pluginId"), IM.el("span", "mono", info.pluginId || "—"));
    line(IM.t("settings.protocol"), IM.el("span", "mono", "stdio-jsonl v" + (info.protocolVersion || 1)));
    if (info.github) {
      const a = IM.el("a", "link", info.github);
      a.href = info.github;
      a.target = "_blank";
      a.rel = "noreferrer";
      line(IM.t("settings.github"), a);
    } else {
      // Deliberately not a dead link: the project page does not exist yet.
      line(IM.t("settings.github"), IM.el("span", "muted", IM.t("settings.githubSoon")));
    }
    const pathWrap = IM.el("span", "path-cell");
    pathWrap.appendChild(IM.el("span", "mono", info.settingsPath || IM.state.settingsPath || "—"));
    const cp = IM.el("button", "btn btn-ghost btn-sm", IM.t("settings.copy"));
    cp.addEventListener("click", () => IM.copyText(info.settingsPath || IM.state.settingsPath || "", true));
    pathWrap.appendChild(cp);
    line(IM.t("settings.settingsPath"), pathWrap);
    sec.appendChild(grid);
    return sec;
  }

  IM.saveSettings = async function saveSettings() {
    if (!IM.state.settings) { IM.toast(IM.t("settings.loadFailed"), "err"); return; }
    const d = IM.draft();
    const err = IM.validateDraft(d);
    if (err) { IM.toast(err, "err"); return; }
    const btn = IM.$("#btnSettingsSave");
    btn.disabled = true;
    try {
      const r = await IM.invoke("settings/set", Object.assign(
        { settings: d },
        IM.state.connectionId ? { connectionId: IM.state.connectionId } : {}));
      IM.state.settings = r.settings;
      IM.state.settingsPath = r.path || IM.state.settingsPath;
      IM.state.settingsIsDefault = false;
      IM.state.settingsDraft = null;
      IM.state.settingsDirty = false;
      IM.toast(IM.t("settings.saved"), "ok");
      IM.renderSettings();
      // Retention markers and the cleanup dialog are derived from settings, so
      // repaint the current view (the listing itself is still cached).
      if (IM.state.current.repo) IM.reloadContent();
    } catch (e) {
      IM.toast(e.message || IM.t("failed"), "err");
    } finally { btn.disabled = false; }
  }

  IM.resetSettings = async function resetSettings() {
    try {
      const r = await IM.invoke("settings/reset", IM.state.connectionId ? { connectionId: IM.state.connectionId } : {});
      IM.state.settings = r.settings;
      IM.state.settingsDraft = null;
      IM.state.settingsDirty = false;
      IM.state.settingsIsDefault = true;
      IM.state.applySeverity = false;
      IM.state.applyArmed = false;
      IM.state.liveSynced = false;
      IM.toast(r.message || IM.t("settings.reset"), "ok");
      IM.renderSettings();
      if (IM.state.current.repo) IM.reloadContent();
    } catch (e) {
      IM.toast(e.message || IM.t("failed"), "err");
    }
  }
})(window.IMREPO = window.IMREPO || {});
