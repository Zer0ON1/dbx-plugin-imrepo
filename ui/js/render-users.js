/* IMREPO workbench — user management.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.renderUserManagement = async function renderUserManagement(sec) {
    // Replace, don't append. Every mutation re-enters this function to refresh
    // the table (admin toggle, create, delete), and appending without removing
    // stacked a fresh copy of the whole section on every click — click the
    // admin switch three times and the panel held three tables.
    //
    // Removing first also settles a re-entrancy race for free: a second call's
    // clear detaches the first call's box, so whatever the first call then
    // writes lands in a node that is no longer displayed.
    Array.from(sec.children).forEach((child) => {
      if (child.classList.contains("user-box")) child.remove();
    });
    const box = IM.el("div", "user-box");
    sec.appendChild(box);
    box.innerHTML = IM.loadingHTML();
    let me, users;
    try {
      [me, users] = await Promise.all([
        IM.invoke("harbor/currentUser", { connectionId: IM.state.connectionId }),
        IM.invoke("harbor/users", { connectionId: IM.state.connectionId }),
      ]);
    } catch (e) {
      box.innerHTML = "";
      box.appendChild(IM.el("p", "hint warn", e.message || IM.t("failed")));
      return;
    }
    box.innerHTML = "";
    const isAdmin = !!(me && me.admin);
    const self = (me && me.user) || {};

    // Non-admin: no create-user, no admin toggle — just the operator's own
    // profile, read-only.
    if (!isAdmin) {
      box.appendChild(IM.el("p", "hint", IM.t("user.readonlyHint")));
      const tbl = IM.el("table", "table admin-table");
      const hr = IM.el("tr");
      [IM.t("user.username"), IM.t("user.email"), IM.t("user.admin")].forEach((h) => hr.appendChild(IM.el("th", "", h)));
      tbl.appendChild(hr);
      const tr = IM.el("tr");
      tr.appendChild(IM.el("td", "", self.username || "—"));
      tr.appendChild(IM.el("td", "", self.email || "—"));
      const tdA = IM.el("td");
      if (self.sysadmin_flag) tdA.appendChild(IM.el("span", "badge ok-soft", IM.t("user.admin")));
      tr.appendChild(tdA);
      tbl.appendChild(tr);
      box.appendChild(tbl);
      return;
    }

    // Admin: create-user form + the full user table, each row carrying an
    // "设为管理员" switch.
    const form = IM.el("div", "user-create");
    const uname = IM.el("input", "set-input"); uname.placeholder = IM.t("user.username");
    const email = IM.el("input", "set-input"); email.placeholder = IM.t("user.email");
    const real = IM.el("input", "set-input"); real.placeholder = IM.t("user.realname");
    const pwd = IM.el("input", "set-input"); pwd.type = "password"; pwd.placeholder = IM.t("user.password");
    const createBtn = IM.el("button", "btn btn-primary btn-sm", IM.t("user.create"));
    createBtn.addEventListener("click", async () => {
      if (!uname.value.trim() || !pwd.value) { IM.toast(IM.t("user.username") + " / " + IM.t("user.password") + "?", "err"); return; }
      createBtn.disabled = true;
      try {
        await IM.invoke("harbor/userCreate", { username: uname.value.trim(), email: email.value.trim(), realname: real.value.trim(), password: pwd.value, connectionId: IM.state.connectionId });
        IM.toast(IM.t("user.created"), "ok");
        IM.renderUserManagement(sec);
      } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); createBtn.disabled = false; }
    });
    form.append(uname, email, real, pwd, createBtn);
    box.appendChild(form);
    if (!users.length) { box.appendChild(IM.el("p", "muted", IM.t("user.none"))); return; }

    const tbl = IM.el("table", "table admin-table");
    const hr = IM.el("tr");
    [IM.t("user.username"), IM.t("user.email"), IM.t("user.admin"), ""].forEach((h) => hr.appendChild(IM.el("th", "", h)));
    tbl.appendChild(hr);
    const tb = IM.el("tbody");
    users.forEach((u) => {
      const isSelf = u.username === self.username;
      const tr = IM.el("tr");
      tr.appendChild(IM.el("td", "", u.username));
      tr.appendChild(IM.el("td", "", u.email || "—"));
      const tdAdmin = IM.el("td");
      if (isSelf) {
        // You cannot demote yourself out of admin — show the fact, not a switch.
        if (u.sysadmin_flag) tdAdmin.appendChild(IM.el("span", "badge ok-soft", IM.t("user.admin")));
      } else {
        const sw = IM.switchControl(!!u.sysadmin_flag, (on) => IM.setUserAdmin(u, on, sec));
        sw.title = IM.t("user.setAdmin");
        tdAdmin.appendChild(sw);
      }
      tr.appendChild(tdAdmin);
      const tdActs = IM.el("td");
      const acts = IM.el("div", "actions");
      const pwdBtn = IM.el("button", "btn btn-outline btn-sm", IM.t("user.setPwd"));
      pwdBtn.addEventListener("click", () => IM.setUserPassword(tr, u, pwdBtn));
      acts.appendChild(pwdBtn);
      if (!isSelf) {
        const delBtn = IM.el("button", "btn btn-outline btn-sm btn-danger-outline", IM.t("user.delete"));
        delBtn.addEventListener("click", () => IM.removeUser(u, sec));
        acts.appendChild(delBtn);
      }
      tdActs.appendChild(acts);
      tr.appendChild(tdActs);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    box.appendChild(tbl);
  }

  IM.setUserAdmin = async function setUserAdmin(u, on, sec) {
    try {
      await IM.invoke("harbor/userAdmin", { userId: u.user_id, admin: on, connectionId: IM.state.connectionId });
      IM.toast(IM.t("done"), "ok");
      IM.renderUserManagement(sec);
    } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); }
  }

  IM.setUserPassword = function setUserPassword(tr, u, btn) {
    const td = tr.querySelector("td:last-child");
    td.innerHTML = "";
    const inp = IM.el("input", "set-input"); inp.type = "password"; inp.placeholder = IM.t("user.newPassword");
    const ok = IM.el("button", "btn btn-primary btn-sm", IM.t("done"));
    ok.addEventListener("click", async () => {
      if (!inp.value) { IM.toast(IM.t("user.newPassword") + "?", "err"); return; }
      ok.disabled = true;
      try {
        await IM.invoke("harbor/userPassword", { userId: u.user_id, newPassword: inp.value, connectionId: IM.state.connectionId });
        IM.toast(IM.t("user.passwordSet"), "ok");
        td.innerHTML = ""; td.appendChild(btn);
      } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); ok.disabled = false; }
    });
    td.append(inp, ok);
  }

  IM.removeUser = async function removeUser(u, sec) {
    try {
      await IM.invoke("harbor/userDelete", { userId: u.user_id, connectionId: IM.state.connectionId });
      IM.toast(IM.t("done"), "ok");
      IM.renderUserManagement(sec);
    } catch (e) { IM.toast(e.message || IM.t("failed"), "err"); }
  }
})(window.IMREPO = window.IMREPO || {});
