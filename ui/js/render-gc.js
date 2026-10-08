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
    // Still needed: it seeds the form below from what is currently saved.
    const params = info.parameters || {};

    /* ---- what is scheduled right now ---- */
    if (configured) {
      // Four columns, labels over values: the schedule reads as one line rather
      // than as scattered key/value pairs.
      const facts = IM.el("div", "gc-facts");
      [IM.t("gc.type"), IM.t("gc.cron"), IM.t("gc.nextRun"), IM.t("gc.lastStatus")]
        .forEach((label) => facts.appendChild(IM.el("span", "k", label)));

      const status = String(info.lastStatus || "").trim();
      const statusCell = IM.el("span", "v mono", status || "—");
      if (status) {
        // Green when it worked, red when it did not; anything else (running,
        // scheduled, never run) stays neutral rather than guessing a colour.
        if (/success|succeed/i.test(status)) statusCell.classList.add("gc-ok");
        else if (/error|fail|stopped|abort/i.test(status)) statusCell.classList.add("gc-bad");
      }

      facts.appendChild(IM.el("span", "v", IM.t("gc.type." + info.type) || info.type));
      facts.appendChild(IM.el("span", "v mono", info.cron || "—"));
      facts.appendChild(IM.el("span", "v", info.nextScheduledAt ? IM.fmtTime(info.nextScheduledAt) : "—"));
      facts.appendChild(statusCell);
      box.appendChild(facts);
      // The two remaining parameters are not repeated here: the form directly
      // below shows them, and it is the thing being edited.
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

    const actions = IM.el("div", "set-actions gc-actions");
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

    // Kept apart on purpose: one writes a schedule, the other starts a real GC
    // run over the whole registry. Side by side they are a mis-click away from
    // each other, so the safe action sits far left and the destructive one far
    // right — the separation is the point, not the styling.
    const saveSide = IM.el("div", "gc-actions-save");
    saveSide.appendChild(save);
    const runSide = IM.el("div", "gc-actions-run");
    runSide.appendChild(run);
    actions.append(saveSide, runSide);
    box.appendChild(actions);
  }
})(window.IMREPO = window.IMREPO || {});
