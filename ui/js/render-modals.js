/* IMREPO workbench — the pull / retag / delete dialogs.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /**
   * Every command the user might paste into a terminal, as separate entries.
   * These used to be concatenated into a single clipboard write, which is
   * useless the moment you only want one of them.
   */
  IM.pullVariants = function pullVariants(image, host) {
    const rows = [
      { id: "image", label: IM.t("pull.image"), cmd: image, ref: true },
      { id: "docker", label: "Docker", cmd: "docker pull " + image },
      { id: "nerdctl", label: "containerd (nerdctl)", cmd: "nerdctl pull " + image },
      { id: "crictl", label: "crictl", cmd: "crictl pull " + image },
      { id: "podman", label: "Podman", cmd: "podman pull " + image },
      { id: "ctr", label: "ctr -n k8s.io", cmd: "ctr -n k8s.io images pull " + image },
    ];
    if (host) rows.push({ id: "login", label: IM.t("pull.login"), cmd: "docker login " + host });
    return rows;
  }

  IM.openPull = function openPull(repo, tag) {
    const host = IM.registryHost();
    const image = (host ? host + "/" : "") + repo + ":" + tag;

    const body = IM.$("#pullBody");
    body.innerHTML = "";
    body.appendChild(IM.el("p", "hint", IM.t("pull.sub")));

    const list = IM.el("div", "cmd-list");
    IM.pullVariants(image, host).forEach((v) => {
      const row = IM.el("div", "cmd-row" + (v.ref ? " cmd-row-ref" : ""));
      const top = IM.el("div", "cmd-row-top");
      top.appendChild(IM.el("span", "cmd-label", v.label));

      const btn = IM.el("button", "btn btn-outline btn-sm copy-btn", IM.t("copy"));
      let timer = null;
      const flash = (label) => {
        btn.textContent = label;
        clearTimeout(timer);
        timer = setTimeout(() => (btn.textContent = IM.t("copy")), 1200);
      };
      // The row itself is the hit target; the button just makes that obvious.
      row.addEventListener("click", async () => {
        flash((await IM.copyText(v.cmd, true)) ? IM.t("copy.done") : IM.t("copyFailed"));
      });
      btn.addEventListener("click", (e) => { e.stopPropagation(); row.click(); });
      top.appendChild(btn);
      row.appendChild(top);
      row.appendChild(IM.el("code", "cmd-text", v.cmd));
      list.appendChild(row);
    });
    body.appendChild(list);

    IM.$("#pullModal").hidden = false;
  }

  /**
   * Opens the retag dialog.
   * @param repo  repository path (project/name for Harbor)
   * @param tags  every tag currently on that artifact — an artifact can carry
   *              several, so the user has to pick which one to rename
   * @param preferred  tag to preselect
   */
  IM.openRetag = function openRetag(repo, tags, preferred) {
    const list = (tags || []).filter(Boolean);
    const sel = IM.$("#retagSource");
    sel.innerHTML = "";
    list.forEach((tg) => {
      const opt = document.createElement("option");
      opt.value = tg;
      opt.textContent = tg;
      sel.appendChild(opt);
    });
    if (preferred && list.includes(preferred)) sel.value = preferred;
    else if (list.length) sel.value = list[0];

    IM.$("#retagRepo").value = repo;
    IM.$("#retagTarget").value = "";

    // Only Harbor can drop a single tag; say so up front rather than silently
    // leaving the old tag behind.
    const canDelete = IM.state.mode === "harbor";
    const box = IM.$("#retagDeleteSource");
    box.disabled = !canDelete;
    box.checked = canDelete;
    IM.$("#retagNotice").hidden = canDelete;

    IM.refreshRetagProtection();

    IM.$("#retagModal").hidden = false;
    IM.$("#retagTarget").focus();
  }

  /**
   * Keeps the retag dialog honest about the retention policy: the source tag may
   * gain a new tag (nothing is lost), but dropping a protected one is refused,
   * so the checkbox is disabled with a reason instead of failing on submit.
   */
  IM.refreshRetagProtection = function refreshRetagProtection() {
    const box = IM.$("#retagDeleteSource");
    const note = IM.$("#retagProtect");
    if (!box || !note) return;
    const source = IM.$("#retagSource").value;
    const pat = IM.protectedPattern(source);
    if (pat) {
      box.checked = false;
      box.disabled = true;
      note.textContent = IM.t("protected.refused") + "  [" + pat + "]";
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = "";
      box.disabled = IM.state.mode !== "harbor";
      if (!box.disabled) box.checked = true;
    }
  }

  IM.openDelete = function openDelete(repo, tag, reference) {
    // Defence in depth: the button already refuses, and so does the backend.
    const pat = IM.protectedPattern(tag);
    if (pat) { IM.toast(IM.t("protected.refused") + "  [" + pat + "]", "err"); return; }
    IM.pendingDelete = { repo, tag, reference };
    IM.$("#deleteMsg").textContent = `${IM.t("retag.repo")}: ${repo}  ·  ${IM.t("tag")}: ${tag}`;
    IM.$("#deleteModal").hidden = false;
  }

  // Same grammar the backend enforces, checked here so the user gets an instant
  // answer instead of a registry round-trip.
  IM.TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
})(window.IMREPO = window.IMREPO || {});
