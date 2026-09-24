/* IMREPO workbench — the layer breakdown dialog.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.openLayers = async function openLayers(repo, reference) {
    // Opening the layers of repository B while A's manifest read is still in
    // flight must not paint A under B's name: only the newest open may render.
    const seq = ++IM.state.layersSeq;
    IM.$("#layersModal").hidden = false;
    IM.$("#layersBody").innerHTML = IM.loadingHTML();
    try {
      const r = await IM.invoke("registry/layers", { repository: repo, reference });
      if (seq !== IM.state.layersSeq) return;
      IM.renderLayers(r);
    } catch (e) {
      if (seq !== IM.state.layersSeq) return;
      IM.$("#layersBody").innerHTML = "";
      IM.$("#layersBody").appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
    }
  }

  /**
   * Renders the layer breakdown. The size of an individual layer is the whole
   * reason this dialog exists, so it is the prominent element of each row:
   * right-aligned, bold, tabular, with a proportional bar and a share of total.
   */
  IM.renderLayers = function renderLayers(r) {
    const body = IM.$("#layersBody");
    body.innerHTML = "";

    const layers = (r && r.layers) || [];
    const total = (r && r.totalSize) || layers.reduce((a, l) => a + (l.size || 0), 0);
    const biggest = layers.reduce((a, l) => ((l.size || 0) > (a ? a.size || 0 : -1) ? l : a), null);

    const sum = IM.el("div", "layer-summary");
    sum.appendChild(IM.el("span", "", IM.t("layersPlatform") + ": " + (r.platform ? ((r.platform.os || "") + "/" + (r.platform.architecture || "")) : "—")));
    sum.appendChild(IM.el("span", "", IM.t("layersCount") + ": " + layers.length));
    sum.appendChild(IM.el("span", "strong", IM.t("layersTotal") + ": " + IM.fmtSize(total)));
    if (biggest) sum.appendChild(IM.el("span", "", IM.t("layersBiggest") + ": " + IM.fmtSize(biggest.size)));
    sum.appendChild(IM.el("span", "mono", IM.t("digest") + ": " + (r.digest ? r.digest.slice(0, 19) : "—")));
    body.appendChild(sum);

    if (!layers.length) {
      body.appendChild(IM.el("p", "muted", IM.t("layersNone")));
      return;
    }

    const toolbar = IM.el("div", "layer-toolbar");
    toolbar.appendChild(IM.el("span", "layer-toolbar-label", IM.t("layersSort")));
    [["index", IM.t("layersByOrder")], ["size", IM.t("layersBySize")]].forEach(([mode, label]) => {
      const b = IM.el("button", "btn btn-outline btn-sm" + (IM.layerOrder === mode ? " active" : ""), label);
      b.addEventListener("click", () => { IM.layerOrder = mode; IM.renderLayers(r); });
      toolbar.appendChild(b);
    });
    body.appendChild(toolbar);

    const ordered = IM.layerOrder === "size"
      ? layers.slice().sort((a, b) => (b.size || 0) - (a.size || 0))
      : layers;

    const list = IM.el("div", "layer-list");
    ordered.forEach((l) => {
      const size = l.size || 0;
      const pct = total > 0 ? (size / total) * 100 : 0;
      const isBiggest = biggest && l.digest && l.digest === biggest.digest;

      const row = IM.el("div", "layer-row" + (isBiggest ? " biggest" : ""));

      const head = IM.el("div", "layer-head");
      head.appendChild(IM.el("span", "layer-idx", String(l.index)));
      head.appendChild(IM.el("span", "cmd", l.command || IM.t("layersNoCommand")));
      head.appendChild(IM.el("span", "layer-size", IM.fmtSize(size)));
      row.appendChild(head);

      const gauge = IM.el("div", "layer-bar");
      const fill = IM.el("span");
      // Keep a hairline for non-empty layers so they are still visible.
      fill.style.width = (size > 0 ? Math.max(pct, 0.6) : 0).toFixed(2) + "%";
      gauge.appendChild(fill);
      row.appendChild(gauge);

      const meta = IM.el("div", "meta");
      meta.appendChild(IM.el("span", "pct", pct.toFixed(1) + "% " + IM.t("layersOfTotal")));
      if (isBiggest) meta.appendChild(IM.el("span", "tag-chip", IM.t("layersBiggestTag")));
      meta.appendChild(IM.el("span", "mono", (l.digest || "").slice(0, 19) || "—"));
      row.appendChild(meta);

      list.appendChild(row);
    });
    body.appendChild(list);
  }
})(window.IMREPO = window.IMREPO || {});
