/* IMREPO workbench — the audit log.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- audit logs ---------- */

  IM.LOG_OPERATIONS = ["pull", "push", "create", "delete"];

  IM.openLogs = async function openLogs() {
    IM.$("#logsModal").hidden = false;
    IM.state.logs = { page: 1, op: "", scope: IM.state.current.project || "", rows: [], pageSize: 50 };
    await IM.renderLogs();
  }

  IM.renderLogs = async function renderLogs() {
    const body = IM.$("#logsBody");
    const st = IM.state.logs;
    body.innerHTML = "";

    /* controls: scope + operation filter */
    const bar = IM.el("div", "logs-bar");
    const scopeSel = IM.el("select", "set-select");
    const all = IM.el("option", "", IM.t("logs.scopeAll"));
    all.value = "";
    scopeSel.appendChild(all);
    if (IM.state.current.project) {
      const o = IM.el("option", "", IM.state.current.project);
      o.value = IM.state.current.project;
      scopeSel.appendChild(o);
    }
    scopeSel.value = st.scope;
    scopeSel.addEventListener("change", () => { st.scope = scopeSel.value; st.page = 1; IM.renderLogs(); });
    const opSel = IM.el("select", "set-select");
    const allOp = IM.el("option", "", IM.t("logs.operation") + " · " + IM.t("logs.all"));
    allOp.value = "";
    opSel.appendChild(allOp);
    IM.LOG_OPERATIONS.forEach((op) => { const o = IM.el("option", "", op); o.value = op; opSel.appendChild(o); });
    opSel.value = st.op;
    opSel.addEventListener("change", () => { st.op = opSel.value; st.page = 1; IM.renderLogs(); });
    bar.append(IM.el("span", "k", IM.t("logs.scope")), scopeSel, IM.el("span", "k", IM.t("logs.operation")), opSel);
    body.appendChild(bar);
    // loadingHTML() is a string; appendChild would throw on it.
    body.insertAdjacentHTML("beforeend", IM.loadingHTML());
    try {
      const params = { page: st.page, pageSize: st.pageSize };
      if (st.scope) params.project = st.scope;
      if (st.op) params.operation = st.op;
      const r = await IM.invoke("harbor/logs", params);
      body.innerHTML = "";
      body.appendChild(bar);
      st.rows = r.logs || [];

      if (!st.rows.length) {
        body.appendChild(IM.el("p", "muted", IM.t("logs.empty")));
        return;
      }
      const tbl = IM.el("table", "table");
      const hr = IM.el("tr");
      [IM.t("logs.time"), IM.t("logs.op"), IM.t("logs.resource"), IM.t("logs.user")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
      tbl.appendChild(hr);
      const tb = IM.el("tbody");
      st.rows.forEach((l) => {
        const tr = IM.el("tr");
        tr.appendChild(IM.el("td", "", IM.fmtTime(l.time)));
        const tdOp = IM.el("td");
        tdOp.appendChild(IM.el("span", "badge soft log-op log-op-" + l.operation, l.operation || "—"));
        tr.appendChild(tdOp);
        const tdRes = IM.el("td");
        const res = IM.el("span", "mono", l.resource || "—");
        res.title = l.resource || "";
        tdRes.appendChild(res);
        tr.appendChild(tdRes);
        tr.appendChild(IM.el("td", "", l.username || "—"));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      body.appendChild(tbl);

      /* pager: Harbor returns at most pageSize rows per page */
      const pager = IM.el("div", "set-actions logs-pager");
      const prev = IM.el("button", "btn btn-outline btn-sm", IM.t("logs.prev"));
      prev.disabled = st.page <= 1;
      prev.addEventListener("click", () => { st.page--; IM.renderLogs(); });
      const next = IM.el("button", "btn btn-outline btn-sm", IM.t("logs.next"));
      next.disabled = st.rows.length < st.pageSize;
      next.addEventListener("click", () => { st.page++; IM.renderLogs(); });
      pager.append(prev, next);
      body.appendChild(pager);
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(IM.el("p", "hint warn", IM.t("logs.loadFailed") + ": " + (e.message || IM.t("failed"))));
    }
  }
})(window.IMREPO = window.IMREPO || {});
