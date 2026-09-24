/* IMREPO workbench — the per-project settings dialog.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- per-folder project settings + user management ---------- */

  IM.ROLE_OPTIONS = [1, 2, 3, 4, 5];

  IM.roleLabel = (id) => IM.t("role." + id) || ("role-" + id);

  /**
   * A two-stop slider for the project access level: Private ←→ Public. Click
   * (or press Enter/Space) flips the stop; the labels light up for the active
   * side. The caller owns persistence — a failed write re-opens the dialog,
   * which restores the true value.
   */
  IM.accessSlider = function accessSlider(isPublic, onChange) {
    let current = !!isPublic;
    const wrap = IM.el("div", "acc-slider" + (current ? " is-public" : ""));
    wrap.setAttribute("role", "switch");
    wrap.setAttribute("aria-checked", String(current));
    wrap.tabIndex = 0;

    const priv = IM.el("span", "acc-label" + (current ? "" : " on"), IM.t("acc.private"));
    const pub = IM.el("span", "acc-label" + (current ? " on" : ""), IM.t("acc.public"));
    const track = IM.el("span", "acc-track");
    track.appendChild(IM.el("span", "acc-thumb"));

    const flip = () => {
      current = !current;
      wrap.classList.toggle("is-public", current);
      priv.classList.toggle("on", !current);
      pub.classList.toggle("on", current);
      wrap.setAttribute("aria-checked", String(current));
      onChange(current);
    };
    track.addEventListener("click", flip);
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
    });
    wrap.append(priv, track, pub);
    return wrap;
  }

  /** Quota: what the project uses now, and the cap the operator can change. */
  IM.renderQuotaSection = function renderQuotaSection(project) {
    const sec = IM.setSection("project.quota", "project.quotaDesc");
    if (IM.state.quotaError) {
      sec.appendChild(IM.el("p", "hint warn", IM.t("project.quotaFailed") + ": " + IM.state.quotaError));
      return sec;
    }
    const q = IM.state.quota;
    if (!q) return sec;

    const grid = IM.el("div", "live-grid");
    const addFact = (k, v) => {
      const cell = IM.el("div", "live-cell");
      cell.appendChild(IM.el("span", "k", k));
      cell.appendChild(IM.el("span", "v", v || "—"));
      grid.appendChild(cell);
    };
    addFact(IM.t("project.quotaUsed"), IM.fmtSize(q.usedBytes));
    addFact(IM.t("project.quotaHard"), q.hardBytes < 0 ? IM.t("project.quotaUnlimited") : IM.fmtSize(q.hardBytes));
    sec.appendChild(grid);

    const GB = 1024 * 1024 * 1024;
    const gbValue = q.hardBytes < 0 ? -1 : Math.round((q.hardBytes / GB) * 10) / 10;
    const inp = IM.el("input", "set-input");
    inp.type = "number";
    inp.step = "0.1";
    inp.value = String(gbValue);
    IM.setRow(sec, "project.quotaHard", "project.quotaHard.help", inp);

    const btn = IM.el("button", "btn btn-primary btn-sm", IM.t("settings.save"));
    btn.addEventListener("click", async () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) { IM.toast(IM.t("project.quotaHard") + "?", "err"); return; }
      const hardBytes = v < 0 ? -1 : Math.round(v * GB);
      btn.disabled = true;
      try {
        await IM.invoke("harbor/quotaSet", { project, hardBytes, connectionId: IM.state.connectionId });
        IM.toast(IM.t("project.quotaSaved"), "ok");
        IM.openProjectSettings(project);
      } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); btn.disabled = false; }
    });
    sec.appendChild(IM.el("div", "set-actions", btn));
    return sec;
  }

  /**
   * Per-project vulnerability scanning: the local policy (threshold, cache,
   * panel on/off) plus the Harbor-side policy rows moved here from the old
   * global scanner panel. The local part saves via settings/setProject; the
   * Harbor part keeps its explicit two-step apply.
   */
  IM.renderProjectScannerSection = function renderProjectScannerSection(project) {
    const d = IM.state.projectScannerDraft;
    const sec = IM.setSection("project.scanner", "settings.scanner.descProject");
    if (IM.state.projectScannerDefault) {
      sec.appendChild(IM.el("p", "hint", IM.t("settings.defaults")));
    }

    IM.setRow(sec, "settings.scannerSource", null,
      IM.selectControl(d.source, [
        { value: "harbor", label: IM.t("settings.scannerSource.harbor") },
        { value: "off", label: IM.t("settings.scannerSource.off") },
      ], (v) => { d.source = v; }));
    IM.setRow(sec, "settings.threshold", null,
      IM.selectControl(d.threshold, ["critical", "high", "medium", "low"].map((v) => ({
        value: v, label: IM.t("settings.sev." + v),
      })), (v) => { d.threshold = v; }));
    IM.setRow(sec, "settings.cacheSeconds", "settings.cacheSeconds.help",
      IM.numberControl(d.cacheSeconds, 0, 86400, (v) => { d.cacheSeconds = v; }));

    sec.appendChild(IM.renderHarborScanPolicy(d));

    const save = IM.el("button", "btn btn-primary btn-sm", IM.t("settings.saveProject"));
    save.addEventListener("click", async () => {
      if (d.cacheSeconds < 0 || d.cacheSeconds > 86400) { IM.toast(IM.t("settings.cacheSeconds"), "err"); return; }
      save.disabled = true;
      try {
        await IM.invoke("settings/setProject", { project, scanner: d, connectionId: IM.state.connectionId });
        IM.state.projectScannerDefault = false;
        IM.toast(IM.t("settings.projectSaved"), "ok");
      } catch (e) {
        IM.toast(e.message || IM.t("failed"), "err");
      } finally { save.disabled = false; }
    });
    sec.appendChild(IM.el("div", "set-actions", save));
    return sec;
  }

  /**
   * Drops the transient dialog state of the project settings form.
   *
   * The two switches in the scanner section are deliberately two-step (arm, then
   * confirm; sync-severity only takes effect on apply). Those flags live in
   * global state, so they would otherwise outlive the dialog: cancelling a
   * pending apply and re-opening the dialog — or opening a different project —
   * would find it still armed. Called on open and on close.
   */
  IM.resetProjectDialogState = function resetProjectDialogState() {
    IM.state.applyArmed = false;
    IM.state.applySeverity = false;
    IM.state.liveSynced = false;
  }

  IM.openProjectSettings = async function openProjectSettings(project) {
    if (IM.state.mode !== "harbor") { IM.toast(IM.t("project.onlyHarbor"), "err"); return; }
    IM.$("#projectSettingsModal").hidden = false;
    IM.$("#projectSettingsBody").innerHTML = IM.loadingHTML();
    // Quota, the Harbor-side scanner policy and the project's scanner settings
    // are independent reads: a failure in one must not blank the whole dialog.
    const [adminR, quotaR, scanR, scannerSetR] = await Promise.allSettled([
      IM.invoke("harbor/projectAdmin", { project, connectionId: IM.state.connectionId }),
      IM.invoke("harbor/quotaGet", { project, connectionId: IM.state.connectionId }),
      IM.invoke("harbor/scannerInfo", { project, connectionId: IM.state.connectionId }),
      IM.invoke("settings/getProject", { project, connectionId: IM.state.connectionId }),
    ]);
    if (adminR.status !== "fulfilled") {
      IM.$("#projectSettingsBody").innerHTML = "";
      IM.$("#projectSettingsBody").appendChild(IM.el("p", "hint warn", adminR.reason?.message || IM.t("project.loadFailed")));
      return;
    }
    const data = adminR.value;
    IM.state.projectAdmin = { project, data };
    IM.state.quota = quotaR.status === "fulfilled" ? quotaR.value : null;
    IM.state.quotaError = quotaR.status === "fulfilled" ? null : (quotaR.reason?.message || IM.t("project.quotaFailed"));
    IM.state.scannerInfo = scanR.status === "fulfilled" ? scanR.value : null;
    IM.state.scannerError = scanR.status === "fulfilled" ? null : (scanR.reason?.message || IM.t("failed"));
    const baseScanner = scannerSetR.status === "fulfilled" ? scannerSetR.value.scanner : IM.defaultSettings().scanner;
    IM.state.projectScannerDefault = scannerSetR.status === "fulfilled" ? !!scannerSetR.value.isDefault : true;
    // Draft copies so cancelling really cancels: local edits are discarded, and
    // the Harbor-side live values are re-seeded once per open.
    IM.state.projectScannerDraft = JSON.parse(JSON.stringify(baseScanner));
    IM.resetProjectDialogState();
    IM.renderProjectSettings(project, data);
  }

  IM.renderProjectSettings = function renderProjectSettings(project, data) {
    const body = IM.$("#projectSettingsBody");
    body.innerHTML = "";
    const proj = data.project || {};
    if (data.projectError) body.appendChild(IM.el("p", "hint warn", IM.t("project.loadFailed") + ": " + data.projectError));

    /* --- access level (private / public, as a two-stop slider) --- */
    if (!data.projectError) {
      const secV = IM.setSection("project.accessLevel", "project.publicDesc");
      IM.setRow(secV, "project.accessLevel", null, IM.accessSlider(!!proj.public, async (on) => {
        try {
          await IM.invoke("harbor/projectSetPublic", { project, public: on, connectionId: IM.state.connectionId });
          IM.toast(IM.t("project.publicSaved"), "ok");
          proj.public = on;
        } catch (e) {
          IM.toast(e.message || IM.t("failed"), "err");
          IM.openProjectSettings(project);   // re-read and restore the slider
        }
      }));
      body.appendChild(secV);
    }

    /* --- storage quota --- */
    body.appendChild(IM.renderQuotaSection(project));

    /* --- vulnerability scanning (this project) --- */
    body.appendChild(IM.renderProjectScannerSection(project));

    /* --- members --- */
    const secM = IM.setSection("project.members", null);
    const members = data.members || [];
    if (data.membersError) {
      secM.appendChild(IM.el("p", "hint warn", data.membersError));
    } else if (!members.length) {
      secM.appendChild(IM.el("p", "muted", IM.t("project.memberEmpty")));
    } else {
      const tbl = IM.el("table", "table admin-table");
      const hr = IM.el("tr");
      [IM.t("project.memberUser"), IM.t("project.memberRole"), ""].forEach((h) => hr.appendChild(IM.el("th", "", h)));
      tbl.appendChild(hr);
      const tb = IM.el("tbody");
      members.forEach((m) => {
        const tr = IM.el("tr");
        tr.appendChild(IM.el("td", "", m.entity_name || m.username || "—"));
        const tdRole = IM.el("td");
        const sel = IM.el("select", "set-select set-select-sm");
        IM.ROLE_OPTIONS.forEach((v) => {
          const opt = IM.el("option", "", IM.roleLabel(v));
          opt.value = String(v);
          if (v === m.role_id) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.addEventListener("change", async () => {
          try {
            await IM.invoke("harbor/memberRole", { project, memberId: m.id, roleId: Number(sel.value), connectionId: IM.state.connectionId });
            IM.toast(IM.t("done"), "ok");
          } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); sel.value = String(m.role_id); }
        });
        tdRole.appendChild(sel);
        tr.appendChild(tdRole);
        const tdDel = IM.el("td");
        tdDel.appendChild(IM.iconBtn(IM.t("user.delete"), "close", () => IM.removeMember(project, m), "danger"));
        tr.appendChild(tdDel);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      secM.appendChild(tbl);
    }

    const addRow = IM.el("div", "member-add");
    const uSel = IM.el("select", "set-select");
    const ph = IM.el("option", "", IM.t("project.memberUser"));
    ph.value = ""; ph.disabled = true; ph.selected = true;
    uSel.appendChild(ph);
    const users = data.users || [];
    if (data.usersError) {
      addRow.appendChild(IM.el("span", "hint warn", data.usersError));
    } else {
      users.forEach((u) => { const o = IM.el("option", "", u.username); o.value = u.username; uSel.appendChild(o); });
    }
    addRow.appendChild(uSel);
    const rSel = IM.el("select", "set-select");
    IM.ROLE_OPTIONS.forEach((v) => { const o = IM.el("option", "", IM.roleLabel(v)); o.value = String(v); rSel.appendChild(o); });
    addRow.appendChild(rSel);
    const addBtn = IM.el("button", "btn btn-primary btn-sm", IM.t("project.memberAdd"));
    addBtn.addEventListener("click", async () => {
      if (!uSel.value) { IM.toast(IM.t("project.memberUser") + "?", "err"); return; }
      addBtn.disabled = true;
      try {
        await IM.invoke("harbor/memberAdd", { project, roleId: Number(rSel.value), username: uSel.value, connectionId: IM.state.connectionId });
        IM.toast(IM.t("done"), "ok");
        IM.openProjectSettings(project);
      } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); addBtn.disabled = false; }
    });
    addRow.appendChild(addBtn);
    secM.appendChild(addRow);
    body.appendChild(secM);

    /* --- retention --- */
    const secR = IM.setSection("project.retention", null);
    secR.appendChild(IM.el("p", "hint", IM.t("project.retentionHint")));
    const ret = data.retention;
    if (data.retentionError) secR.appendChild(IM.el("p", "hint warn", data.retentionError));
    else if (!ret) secR.appendChild(IM.el("p", "muted", IM.t("project.retentionNone")));
    const keepN = IM.numberControl(0, 0, 1000, () => {});
    const daysN = IM.numberControl(0, 0, 3650, () => {});
    if (ret && ret.rules) {
      ret.rules.forEach((r) => {
        if (r.template === "latestPushedK" && r.params && r.params.latestPushedK != null) keepN.value = String(r.params.latestPushedK);
        if (r.template === "nDaysSinceLastPush" && r.params && r.params.nDaysSinceLastPush != null) daysN.value = String(r.params.nDaysSinceLastPush);
      });
    }
    const cron = IM.el("input", "set-input set-input-cron");
    cron.value = (ret && ret.trigger && ret.trigger.settings && ret.trigger.settings.cron) || "0 0 2 * * *";
    IM.setRow(secR, "project.retentionKeep", null, keepN);
    IM.setRow(secR, "project.retentionDays", null, daysN);
    IM.setRow(secR, "project.retentionCron", null, cron);
    const saveBtn = IM.el("button", "btn btn-primary btn-sm", IM.t("project.retentionSave"));
    saveBtn.addEventListener("click", async () => {
      const k = Number(keepN.value || 0), d = Number(daysN.value || 0);
      const rules = [];
      const tagSel = [{ kind: "doublestar", decoration: "matches", pattern: "**" }];
      const repoSel = { repository: [{ kind: "doublestar", decoration: "repoMatches", pattern: "**" }] };
      if (k > 0) rules.push({ disabled: false, action: "retain", template: "latestPushedK", params: { latestPushedK: k }, tag_selectors: tagSel, scope_selectors: repoSel });
      if (d > 0) rules.push({ disabled: false, action: "retain", template: "nDaysSinceLastPush", params: { nDaysSinceLastPush: d }, tag_selectors: tagSel, scope_selectors: repoSel });
      if (!rules.length) { IM.toast(IM.t("project.retentionKeep") + "?", "err"); return; }
      const policy = {
        id: (ret && ret.id) || 0,
        algorithm: "or",
        rules,
        trigger: { kind: "Schedule", settings: { cron: cron.value || "0 0 2 * * *" } },
        scope: (ret && ret.scope) || { level: "project", ref: proj.projectId || 0 },
      };
      saveBtn.disabled = true;
      try {
        await IM.invoke("harbor/retentionSave", { project, projectId: proj.projectId || 0, policy, connectionId: IM.state.connectionId });
        IM.toast(IM.t("project.retentionSaved"), "ok");
        IM.openProjectSettings(project);
      } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); saveBtn.disabled = false; }
    });
    const acts = IM.el("div", "set-actions"); acts.appendChild(saveBtn);
    secR.appendChild(acts);
    body.appendChild(secR);
  }

  IM.removeMember = async function removeMember(project, m) {
    try {
      await IM.invoke("harbor/memberRemove", { project, memberId: m.id, connectionId: IM.state.connectionId });
      IM.toast(IM.t("done"), "ok");
      IM.openProjectSettings(project);
    } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); }
  }
})(window.IMREPO = window.IMREPO || {});
