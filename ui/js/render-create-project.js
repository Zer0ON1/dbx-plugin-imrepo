/* IMREPO workbench — the create-project dialog.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  /* ---------- create project ---------- */

  IM.openCreateProject = function openCreateProject() {
    if (IM.state.mode !== "harbor") { IM.toast(IM.t("project.onlyHarbor"), "err"); return; }
    IM.$("#newProjectName").value = "";
    IM.state.createPublic = false;
    const box = IM.$("#newProjectAccess");
    box.innerHTML = "";
    box.appendChild(IM.accessSlider(false, (on) => { IM.state.createPublic = on; }));
    IM.$("#createProjectModal").hidden = false;
    IM.$("#newProjectName").focus();
  }

  IM.submitCreateProject = async function submitCreateProject() {
    const name = IM.$("#newProjectName").value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,254}$/.test(name)) { IM.toast(IM.t("np.nameInvalid"), "err"); return; }
    const btn = IM.$("#btnCreateProjectConfirm");
    btn.disabled = true;
    try {
      await IM.invoke("harbor/projectCreate", { name, public: !!IM.state.createPublic });
      IM.$("#createProjectModal").hidden = true;
      IM.toast(IM.t("np.created") + ": " + name, "ok");
      // The sidebar tree is derived from the project list — refresh it.
      const projects = await IM.invoke("harbor/projects");
      if (Array.isArray(projects)) { IM.state.projects = projects; IM.renderSidebar(); }
    } catch (e) {
      IM.toast(e.message || IM.t("failed"), "err");
    } finally { btn.disabled = false; }
  }
})(window.IMREPO = window.IMREPO || {});
