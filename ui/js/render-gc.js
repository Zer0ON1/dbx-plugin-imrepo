/* IMREPO workbench — Harbor's registry garbage collection.
 *
 * Distinct from the untagged-artifact cleanup: that one deletes artifacts
 * through the API, and deleting an artifact only unlinks it. GC is what
 * reclaims the blobs those deletions orphan, so the two belong next to each
 * other but are not the same operation.
 *
 * Classic script, not an ES module: the workbench is also opened over file://,
 * where module scripts are refused by CORS. Everything hangs off `window.IMREPO`.
 */
(function (IM) {
  "use strict";

  /* The schedule types Harbor accepts. "Manual" is deliberately absent: it is
     not a schedule, it is a one-off run, and it has its own button. */
  IM.GC_TYPES = ["None", "Hourly", "Daily", "Weekly", "Custom"];

  IM.renderGCSection = async function renderGCSection(sec) {
    const box = IM.el("div", "gc-box");
    sec.appendChild(box);
    box.innerHTML = IM.loadingHTML();

    let info;
    try {
      info = await IM.invoke("harbor/gcGet", { connectionId: IM.state.connectionId }) || {};
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(IM.el("p", "hint warn", e.message || IM.t("gc.loadFailed")));
      return;
    }
    box.innerHTML = "";
    IM.state.gc = info;

    const configured = !!info.configured;
    const params = info.parameters || {};

    /* ---- what is scheduled right now ---- */
    if (configured) {
      const facts = IM.el("div", "live-grid");
      const addFact = (k, v) => {
        facts.appendChild(IM.el("span", "k", k));
        facts.appendChild(IM.el("span", "v", v || "—"));
      };
      addFact(IM.t("gc.type"), IM.t("gc.type." + info.type) || info.type);
      addFact(IM.t("gc.cron"), info.cron);
      addFact(IM.t("gc.nextRun"), IM.fmtTime(info.nextScheduledAt));
      addFact(IM.t("gc.lastStatus"), info.lastStatus);
      box.appendChild(facts);
      if (params.delete_untagged !== undefined || params.workers !== undefined) {
        box.appendChild(IM.el("p", "hint",
          IM.t("gc.deleteUntagged") + ": " + (params.delete_untagged ? IM.t("yes") : IM.t("no"))
          + "  ·  " + IM.t("gc.workers") + ": " + (params.workers ?? "—")));
      }
    } else {
      box.appendChild(IM.el("p", "hint", IM.t("gc.notConfigured")));
    }

    /* ---- editing ---- */
    const draft = {
      scheduleType: configured ? info.type : "None",
      cron: configured ? (info.cron || "") : "",
      deleteUntagged: params.delete_untagged !== false,
      workers: Number(params.workers) || 1,
    };
    const form = IM.el("div", "gc-form");

    const typeRow = IM.el("div", "gc-row");
    typeRow.appendChild(IM.el("span", "k", IM.t("gc.schedule")));
    const typeSel = IM.el("select", "set-select");
    IM.GC_TYPES.forEach((t) => {
      const o = IM.el("option", "", IM.t("gc.type." + t));
      o.value = t;
      typeSel.appendChild(o);
    });
    typeSel.value = draft.scheduleType;
    typeRow.appendChild(typeSel);
    form.appendChild(typeRow);

    const cronRow = IM.el("div", "gc-row");
    cronRow.appendChild(IM.el("span", "k", IM.t("gc.cron")));
    const cronInput = IM.el("input", "set-input mono");
    cronInput.placeholder = "0 0 0 * * *";
    cronInput.value = draft.cron;
    cronRow.appendChild(cronInput);
    form.appendChild(cronRow);

    const optsRow = IM.el("div", "gc-row");
    const unWrap = IM.el("label", "gc-check");
    const unBox = IM.el("input");
    unBox.type = "checkbox";
    unBox.checked = draft.deleteUntagged;
    unWrap.append(unBox, IM.el("span", "", IM.t("gc.deleteUntagged")));
    const wkWrap = IM.el("label", "gc-check");
    const wkInput = IM.el("input", "set-input");
    wkInput.type = "number";
    wkInput.min = "1";
    wkInput.max = "10";
    wkInput.value = String(draft.workers);
    wkWrap.append(IM.el("span", "", IM.t("gc.workers")), wkInput);
    optsRow.append(unWrap, wkWrap);
    form.appendChild(optsRow);

    /* Cron is only meaningful for Custom; the named schedules carry their own. */
    const syncCronVisibility = () => {
      const custom = typeSel.value === "Custom";
      cronInput.disabled = !custom;
      cronInput.parentElement.hidden = !custom;
    };
    typeSel.addEventListener("change", syncCronVisibility);
    syncCronVisibility();
    box.appendChild(form);

    const status = IM.el("p", "hint");
    box.appendChild(status);

    const actions = IM.el("div", "set-actions");
    const save = IM.el("button", "btn btn-primary btn-sm", IM.t("gc.save"));
    save.addEventListener("click", async () => {
      const workers = Number(wkInput.value);
      if (!Number.isFinite(workers) || workers < 1 || workers > 10) {
        IM.toast(IM.t("gc.badWorkers"), "warn");
        return;
      }
      save.disabled = true;
      status.textContent = "";
      try {
        await IM.invoke("harbor/gcSet", {
          connectionId: IM.state.connectionId,
          scheduleType: typeSel.value,
          cron: typeSel.value === "Custom" ? cronInput.value.trim() : "",
          delete_untagged: unBox.checked,
          workers,
        });
        IM.toast(IM.t("gc.saved"), "ok");
        IM.renderGCSection(sec);
      } catch (e) {
        status.textContent = e.message || IM.t("failed");
        status.className = "hint warn";
        save.disabled = false;
      }
    });

    /* Running GC is two-step: it is a system-wide storage operation and cannot
       be undone, so a stray click must not start one. */
    const run = IM.el("button", "btn btn-danger btn-sm", IM.t("gc.run"));
    run.addEventListener("click", async () => {
      if (run.dataset.armed !== "1") {
        run.dataset.armed = "1";
        run.textContent = IM.t("gc.runArm");
        run.className = "btn btn-danger btn-sm";
        setTimeout(() => {
          if (run.dataset.armed === "1") {
            run.dataset.armed = "0";
            run.textContent = IM.t("gc.run");
          }
        }, 5000);
        return;
      }
      run.dataset.armed = "0";
      run.disabled = true;
      run.textContent = IM.t("gc.running");
      try {
        await IM.invoke("harbor/gcTrigger", {
          connectionId: IM.state.connectionId,
          delete_untagged: unBox.checked,
          workers: Number(wkInput.value) || 1,
        });
        IM.toast(IM.t("gc.started"), "ok");
        status.textContent = IM.t("gc.startedHint");
        status.className = "hint";
      } catch (e) {
        status.textContent = e.message || IM.t("failed");
        status.className = "hint warn";
      } finally {
        run.disabled = false;
        run.textContent = IM.t("gc.run");
      }
    });

    actions.append(save, run);
    box.appendChild(actions);
  }
})(window.IMREPO = window.IMREPO || {});
