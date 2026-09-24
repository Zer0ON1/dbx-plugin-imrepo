/* IMREPO workbench — the CVE report dialog.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.openVuln = async function openVuln(repo, reference, digest, force) {
    if (IM.state.mode !== "harbor") { IM.toast(IM.t("noVuln"), "ok"); return; }
    const seq = ++IM.state.vulnSeq;
    IM.state.vulnRef = { repo, reference, digest };
    IM.$("#vulnModal").hidden = false;
    IM.$("#vulnBody").innerHTML = IM.loadingHTML();
    try {
      const ref = digest || reference;
      const r = await IM.invoke("harbor/vulnerabilities", {
        project: IM.state.current.project,
        repository: repo.replace(IM.state.current.project + "/", ""),
        reference: ref,
        force: !!force,     // the refresh button bypasses the cache TTL
      });
      if (seq !== IM.state.vulnSeq) return;
      IM.renderVuln(r);
    } catch (e) {
      if (seq !== IM.state.vulnSeq) return;
      IM.$("#vulnBody").innerHTML = "";
      IM.$("#vulnBody").appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
    }
  }

  IM.renderVuln = function renderVuln(r) {
    const body = IM.$("#vulnBody");
    body.innerHTML = "";
    if (r && r.disabled) {
      body.appendChild(IM.el("p", "hint warn", r.reason || IM.t("vuln.disabled")));
      return;
    }
    const vuls = (r && r.vulnerabilities) || [];
    const sevs = ["Critical", "High", "Medium", "Low"];
    const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    if (r && r.counts && typeof r.counts === "object") {
      sevs.forEach((sv) => { counts[sv] = r.counts[sv] || 0; });
    } else {
      vuls.forEach((v) => { if (counts[v.severity] != null) counts[v.severity]++; });
    }
    const threshold = (r && r.threshold) || "high";

    // Threshold context, so a report is read against the configured bar rather
    // than against intuition.
    const meta = IM.el("div", "vuln-meta");
    meta.appendChild(IM.el("span", "", IM.t("vuln.threshold") + ": " + threshold));
    meta.appendChild(IM.el("span", "badge " + (r && r.exceedsThreshold ? "danger-soft" : "ok-soft"),
      r && r.exceedsThreshold ? IM.t("vuln.exceeds") : IM.t("vuln.within")));
    if (r && r.highest) meta.appendChild(IM.el("span", "strong", r.highest));
    if (r && r.scanner) meta.appendChild(IM.el("span", "muted", IM.t("vuln.scanner") + ": " + r.scanner));
    if (r && r.cached) meta.appendChild(IM.el("span", "badge soft", IM.t("vuln.cached")));
    if (r && r.generatedAt) meta.appendChild(IM.el("span", "muted", r.generatedAt));
    body.appendChild(meta);

    const s = IM.el("div", "vuln-summary");
    sevs.forEach((sv) => {
      // A level at or above the threshold is the one that matters, so mark it.
      const over = IM.severityRank(sv) >= IM.severityRank(threshold);
      const box = IM.el("div", "sev-box " + sv.toLowerCase() + (over ? " over" : ""));
      box.appendChild(IM.el("div", "num", String(counts[sv])));
      box.appendChild(IM.el("div", "lbl", sv));
      if (over) box.title = IM.t("vuln.exceeds");
      s.appendChild(box);
    });
    body.appendChild(s);

    const ref = IM.state.vulnRef || {};
    const acts = IM.el("div", "vuln-actions");
    const refresh = IM.el("button", "btn btn-outline btn-sm", IM.t("vuln.refresh"));
    refresh.addEventListener("click", () => IM.openVuln(ref.repo, ref.reference, ref.digest, true));
    acts.appendChild(refresh);
    const rescan = IM.el("button", "btn btn-outline btn-sm");
    rescan.appendChild(IM.svgIcon("scan"));
    rescan.appendChild(IM.el("span", "", IM.t("vuln.rescan")));
    rescan.addEventListener("click", async () => {
      rescan.disabled = true;
      try {
        await IM.invoke("harbor/scan", {
          project: IM.state.current.project,
          repository: (ref.repo || "").replace(IM.state.current.project + "/", ""),
          reference: ref.digest || ref.reference,
        });
        IM.toast(IM.t("vuln.requested"), "ok");
      } catch (e) {
        IM.toast(e.message || IM.t("failed"), "err");
      } finally { rescan.disabled = false; }
    });
    acts.appendChild(rescan);
    body.appendChild(acts);

    if (!vuls.length) { body.appendChild(IM.el("p", "muted", IM.t("noVuln"))); return; }
    const table = IM.el("table", "table vuln-table");
    const thead = IM.el("thead");
    const hr = IM.el("tr");
    [IM.t("severity"), "CVE / ID", "Package", "Version"].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = IM.el("tbody");
    vuls.slice(0, 200).forEach((v) => {
      const tr = IM.el("tr");
      const tdS = IM.el("td");
      const sev = IM.el("span", "sev " + (v.severity || ""));
      sev.textContent = v.severity || "—";
      tdS.appendChild(sev);
      tr.appendChild(tdS);
      tr.appendChild(IM.el("td", "mono", v.id || v.cve_id || "—"));
      tr.appendChild(IM.el("td", "", v.package || v.package_name || "—"));
      tr.appendChild(IM.el("td", "mono", v.version || "—"));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }
})(window.IMREPO = window.IMREPO || {});
