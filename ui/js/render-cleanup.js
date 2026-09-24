/* IMREPO workbench — the untagged-cleanup dialog.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.setCleanupConfirm = function setCleanupConfirm(count) {
    const btn = IM.$("#btnCleanupConfirm");
    if (!btn) return;
    btn.disabled = count === 0;
    btn.textContent = count ? `${IM.t("cleanup.confirm")} (${count})` : IM.t("cleanup.confirm");
  }

  IM.openCleanup = async function openCleanup() {
    if (IM.state.mode !== "harbor") { IM.toast(IM.t("cleanup.needHarbor"), "warn"); return; }
    const project = IM.state.current.project;
    if (!project) { IM.toast(IM.t("cleanup.needProject"), "warn"); return; }

    // Same race as the other dialogs: a slow scan for project A must not paint
    // into a dialog the operator has already re-opened on project B.
    const seq = ++IM.state.cleanupSeq;
    IM.$("#cleanupModal").hidden = false;
    const body = IM.$("#cleanupBody");
    body.innerHTML = IM.loadingHTML();
    IM.pendingCleanup = null;
    IM.setCleanupConfirm(0);
    try {
      const scan = await IM.invoke("harbor/untagged", { project });
      if (seq !== IM.state.cleanupSeq) return;
      IM.renderCleanup(project, scan);
    } catch (e) {
      if (seq !== IM.state.cleanupSeq) return;
      body.innerHTML = "";
      body.appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
    }
  }

  IM.renderCleanup = function renderCleanup(project, scan) {
    const body = IM.$("#cleanupBody");
    body.innerHTML = "";
    const items = (scan && scan.items) || [];

    const sum = IM.el("div", "cleanup-summary");
    sum.appendChild(IM.el("span", "", IM.t("cleanup.project") + ": " + project));
    sum.appendChild(IM.el("span", "", IM.t("cleanup.scanned") + ": " +
      (scan.scannedRepositories || 0) + "/" + (scan.totalRepositories || 0)));
    sum.appendChild(IM.el("span", "strong", IM.t("cleanup.found") + ": " + items.length));
    if (items.length) sum.appendChild(IM.el("span", "strong", IM.t("cleanup.reclaim") + ": " + IM.fmtSize(scan.totalSize || 0)));
    if (scan.protectedCount) sum.appendChild(IM.el("span", "", IM.t("cleanup.protected") + ": " + scan.protectedCount));
    body.appendChild(sum);

    // Show which rules produced this list: a shorter list than expected should be
    // explainable without opening Settings.
    const rules = scan.rules || {};
    const ruleBits = [];
    if (rules.keepUntagged) ruleBits.push([IM.t("cleanup.ruleKeep"), rules.keepUntagged, IM.t("cleanup.ruleKeepUnit")].filter(Boolean).join(" "));
    if (rules.minAgeDays) ruleBits.push([IM.t("cleanup.ruleMinAge"), rules.minAgeDays, IM.t("cleanup.ruleDays")].filter(Boolean).join(" "));
    if ((rules.excludeRepos || []).length) ruleBits.push(IM.t("cleanup.ruleExclude") + " " + rules.excludeRepos.join(" "));
    if (ruleBits.length) body.appendChild(IM.el("p", "hint", IM.t("cleanup.byRules") + " — " + ruleBits.join(" · ")));

    if (scan.truncated) body.appendChild(IM.el("p", "hint warn", IM.t("cleanup.truncated")));
    if ((scan.repositoryErrors || []).length) {
      body.appendChild(IM.el("p", "hint warn", IM.t("cleanup.repoErrors") + ": " + scan.repositoryErrors.join("; ")));
    }

    if (!items.length) {
      body.appendChild(IM.el("p", "muted", IM.t("cleanup.none")));
      return;
    }

    body.appendChild(IM.el("p", "hint", IM.t("cleanup.sub")));

    const table = IM.el("table", "table cleanup-table");
    const thead = IM.el("thead");
    const hr = IM.el("tr");
    const thAll = IM.el("th", "col-check");
    const all = IM.el("input");
    all.id = "cleanupAll";
    all.type = "checkbox";
    all.checked = true;
    all.title = IM.t("cleanup.selectAll");
    thAll.appendChild(all);
    hr.appendChild(thAll);
    [IM.t("cleanup.repository"), IM.t("digest"), IM.t("size"), IM.t("pushed"), IM.t("cleanup.status")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);

    const boxes = [];
    const tbody = IM.el("tbody");
    items.forEach((it) => {
      // A rule-protected row stays visible (so the rule is not a mystery) but
      // cannot be selected, and the backend refuses it anyway.
      const blocked = !!it.protected;
      const tr = IM.el("tr", blocked ? "row-blocked" : "");
      const td = IM.el("td", "col-check");
      const cb = IM.el("input");
      cb.type = "checkbox";
      cb.checked = !blocked;
      cb.disabled = blocked;
      cb.dataset.repo = it.repository;
      cb.dataset.digest = it.digest;
      td.appendChild(cb);
      tr.appendChild(td);
      tr.appendChild(IM.el("td", "mono", it.repository));
      const tdDigest = IM.el("td", "mono digest-cell");
      const dg = IM.el("span", "", IM.shortDigest(it.digest));
      dg.title = it.digest || "";   // full value stays available on hover
      tdDigest.appendChild(dg);
      tr.appendChild(tdDigest);
      tr.appendChild(IM.el("td", "", IM.fmtSize(it.size)));
      tr.appendChild(IM.el("td", "", IM.fmtTime(it.push_time)));
      const tdStatus = IM.el("td");
      if (blocked) {
        const chip = IM.el("span", "badge warn-soft", IM.t("cleanup.protected"));
        chip.title = it.protectedReason || "";
        tdStatus.appendChild(chip);
        tdStatus.appendChild(IM.el("span", "reason", it.protectedReason || ""));
      } else {
        tdStatus.appendChild(IM.el("span", "badge ok-soft", IM.t("cleanup.eligible")));
      }
      tr.appendChild(tdStatus);
      tbody.appendChild(tr);
      boxes.push({ cb, item: it, blocked });
    });
    table.appendChild(tbody);
    body.appendChild(table);

    const count = () => boxes.filter((b) => b.cb.checked && !b.blocked).length;
    boxes.forEach((b) => b.cb.addEventListener("change", () => IM.setCleanupConfirm(count())));
    all.checked = boxes.some((b) => !b.blocked);
    all.disabled = !all.checked;
    all.addEventListener("change", () => {
      boxes.forEach((b) => { if (!b.blocked) b.cb.checked = all.checked; });
      IM.setCleanupConfirm(count());
    });

    IM.pendingCleanup = { project, boxes };
    IM.setCleanupConfirm(count());   // everything is selected by default
  }

  IM.runCleanup = async function runCleanup() {
    if (!IM.pendingCleanup) return;
    const targets = IM.pendingCleanup.boxes
      .filter((b) => b.cb.checked)
      .map((b) => ({ repository: b.item.repository, reference: b.item.digest, size: b.item.size || 0 }));
    if (!targets.length) { IM.toast(IM.t("cleanup.nothingSelected"), "err"); return; }

    const btn = IM.$("#btnCleanupConfirm");
    btn.disabled = true;
    btn.textContent = IM.t("cleanup.working");
    try {
      const r = await IM.invoke("harbor/cleanupUntagged", { project: IM.pendingCleanup.project, targets });
      IM.$("#cleanupModal").hidden = true;
      const parts = [`${IM.t("cleanup.deleted")} ${r.deletedCount || 0}`];
      if (r.reclaimedBytes) parts.push(`${IM.t("cleanup.reclaimed")} ${IM.fmtSize(r.reclaimedBytes)}`);
      if ((r.skipped || []).length) parts.push(`${IM.t("cleanup.skipped")} ${r.skipped.length}`);
      if ((r.failed || []).length) parts.push(`${IM.t("cleanup.failedCount")} ${r.failed.length}`);
      IM.toast(parts.join(" · "), (r.failed || []).length ? "err" : "ok");
      IM.invalidate(IM.currentKey());
      IM.reloadContent();
    } catch (e) {
      IM.toast(e.message || IM.t("failed"), "err");
    } finally {
      IM.pendingCleanup = null;
      IM.setCleanupConfirm(0);
    }
  }
})(window.IMREPO = window.IMREPO || {});
