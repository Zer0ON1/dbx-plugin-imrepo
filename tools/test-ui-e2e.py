#!/usr/bin/env python3
"""Headless regression test for the workbench UI (rendered in a real browser).

Renders the real workbench (generated preview harness) in a headless browser and
asserts on the resulting DOM. Covers things that are easy to regress and painful
to notice by hand:

  A  race     — clicking repository A (slow) and then B (fast) must end up showing
                B. Without a sequence guard, A's late response paints A's
                artifacts under B's name.
  B  spinner  — while a repository is loading, the content pane shows a spinner and
                the clicked sidebar row shows its own spinner.
  C  prefetch — expanding a project warms repositories in the background, and
                clicking a warmed repository renders without a second request.
  D  cleanup   — the untagged-cleanup dialog lists what it found, reports the scan,
                and keeps its destructive button disabled when nothing is selected.
  E  cleanup   — with no selection there is no way to trigger a deletion.

Run:  python tools/test-ui-e2e.py      (exit 0 = all pass; skips if no browser)
      CHROME_HEADLESS_SHELL=/path/to/chrome-headless-shell to pick the browser
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import signal
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _harness  # noqa: E402  (needs the path fix above)

ROOT = _harness.ROOT
PREVIEW = ROOT / ".preview" / "preview.html"
# Read from the manifest rather than restating it: a plugin-id rename should not
# have to be chased into the tests.
PLUGIN_ID = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["id"]

# Wall-clock ceiling for one browser run. It only has to be reached when the
# browser is broken; a healthy run finishes in a few seconds.
_WALL_CLOCK_LIMIT_S = 120
SLOW = "ledger-api"      # deliberately delayed repository
FAST = "audit-api"            # answers immediately

_reporter = _harness.Reporter("ui")
check = _reporter.check
find_browser = _harness.find_browser


class Browser:
    def __init__(self, exe: str, workdir: pathlib.Path):
        self.exe = exe
        self.headless_shell = _harness.is_headless_shell(exe)
        self.workdir = workdir
        self.runs = 0

    def dom(self, query: str, budget_ms: int) -> str:
        """Loads preview.html?<query> and returns the DOM at `budget_ms` of virtual time.

        Notes on the flags, all of which exist because of a real hang:

        - chrome-headless-shell is headless by construction; only a full browser
          needs `--headless=new`, and it is preferred precisely because the full
          one is the balky case.
        - `--virtual-time-budget` fast-forwards timers, it is not a wall-clock
          wait. `--timeout` is the wall-clock bound: Chrome dumps the page when
          it expires even if the page is still busy.
        - The process gets its own session so the kill on timeout reaches the
          whole tree. A full browser is known to write its output and then keep
          the pipes open, which blocks the caller long after the DOM exists —
          observed on a macOS runner as a 180s timeout with no output.
        - The output is validated before it is returned. An empty string would
          quietly satisfy assertions of the form "X is not in dom", so a browser
          that produced nothing would look like a pass.
        """
        self.runs += 1
        profile = self.workdir / f"p{self.runs}"
        # PREVIEW.as_posix() is already absolute, so "file://" + it is the
        # three-slash form; a fourth slash is a typo that happens to work.
        url = f"file://{PREVIEW.as_posix()}?{query}"
        argv = [self.exe]
        if not self.headless_shell:
            argv.append("--headless=new")
        argv += [
            "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
            "--force-device-scale-factor=1", "--window-size=1360,880",
            f"--virtual-time-budget={budget_ms}",
            f"--timeout={budget_ms + 15000}",
            f"--user-data-dir={profile}",
            "--dump-dom", url,
        ]
        proc = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="ignore",
            start_new_session=os.name != "nt",
        )
        try:
            out, _ = proc.communicate(timeout=_WALL_CLOCK_LIMIT_S)
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            raise BrowserStalled(
                f"the browser did not exit within {_WALL_CLOCK_LIMIT_S}s "
                f"(?{query}) — it may be holding its output pipe open"
            ) from None
        dom = out or ""
        if "<html" not in dom:
            kill_tree(proc)
            raise BrowserStalled(f"the browser produced no DOM (?{query})")
        return dom


class BrowserStalled(RuntimeError):
    """The browser failed to render — a harness failure, not a product one."""


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill the browser and anything it spawned.

    Killing only the leader can leave helpers alive with our pipes still open,
    which is how a "finished" browser blocks its caller forever.
    """
    try:
        if os.name == "nt":
            proc.kill()
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def probe_requests(dom: str) -> list[str]:
    m = re.search(r'id="__probe"[^>]*>([^<]*)<', dom)
    return [x for x in (m.group(1) if m else "").split(",") if x]


def main() -> int:
    if not PREVIEW.exists():
        sys.exit("preview harness missing — run: python tools/make-preview.py")
    exe = find_browser()
    if not exe:
        message = (
            "no Chromium-based browser found, so the UI suite cannot run.\n"
            "  install chrome-headless-shell, or point CHROME_HEADLESS_SHELL at it:\n"
            "    CHROME_HEADLESS_SHELL=/path/to/chrome-headless-shell python3 tools/test-ui-e2e.py"
        )
        # Skipping here would be indistinguishable from passing, and the point of
        # running this on three platforms is to know the UI really was exercised.
        if os.environ.get("CI"):
            sys.exit(message)
        print(message + "\n  (not CI, so this is a skip)")
        return 0
    print(f"browser: {exe}")
    print(f"harness: {PREVIEW.relative_to(ROOT)}")

    work = pathlib.Path(tempfile.mkdtemp(prefix="imrepo-loading-"))
    browser = Browser(exe, work)

    try:
        print("\nA) click a slow repository, then a fast one → the fast one wins")
        # Slow repo first at t=700ms, fast one at t=1100ms; the slow response lands
        # at ~3.2s, i.e. long after the selection moved on.
        query = f"theme=light&probe=1&slowrepo={SLOW}&slowms=2500&race={SLOW}"
        dom = browser.dom(query, 8000)
        check("fast repository's artifacts are shown", f"{FAST}-1" in dom,
              "expected a tag belonging to " + FAST)
        check("slow repository's artifacts are NOT shown", f"{SLOW}-1" not in dom,
              "stale response painted over the newer view")
        check("breadcrumb shows the fast repository",
              f'<span class="current">{FAST}</span>' in dom)
        check("fast repository row is the active one",
              re.search(rf'class="tree-item lvl2 active"[^>]*>(?:(?!</div>).)*?{FAST}', dom, re.S) is not None)

        print("\nB) while loading: content spinner + per-row spinner")
        # Freeze just after the slow click (t=700ms), before its response.
        dom_mid = browser.dom(f"theme=light&probe=1&slowrepo={SLOW}&slowms=2500&race={SLOW}", 900)
        check("content pane shows a loading spinner", 'class="loading"' in dom_mid, dom_mid[-400:])
        row = re.search(rf'<div class="tree-item lvl2"(?![^>]*hidden)[^>]*data-key="[^"]*{SLOW}"[^>]*>(.*?)</div></div>', dom_mid, re.S)
        if row is None:
            # fall back to a looser match: the slow row must not carry a hidden spinner
            loose = re.search(rf'data-key="[^"]*{SLOW}"(.{{0,600}})', dom_mid, re.S)
            check("loading row has a visible spinner",
                  loose is not None and 'class="row-spinner" hidden' not in loose.group(1),
                  loose.group(1)[:200] if loose else "row not found")
        else:
            check("loading row has a visible spinner", 'row-spinner" hidden' not in row.group(1))

        print("\nC) expanding a project prefetches repositories; a warmed click is a cache hit")
        # Click docs-api at t=4s, long after the prefetch pass finished.
        dom = browser.dom("theme=light&probe=1&clickrepo=docs-api", 7000)
        reqs = probe_requests(dom)
        warmed = [r for r in reqs if r.startswith("harbor/artifacts:")]
        check("background prefetch requested repository listings", len(warmed) >= 3,
              f"only {len(warmed)} artifact listing(s): {reqs[:12]}")
        check("prefetch is bounded (does not scan the whole project)", len(warmed) <= 6,
              f"{len(warmed)} listings requested")
        check("no repository listing was requested twice",
              len(warmed) == len(set(warmed)), f"duplicates in {warmed}")
        check("clicking a warmed repository served it from cache (single request)",
              warmed.count("harbor/artifacts:docs-api") == 1,
              f"requests: {warmed}")
        check("the warmed repository's artifacts are on screen", "docs-api-1" in dom)
        check("the tree shows no spinner once everything settled", 'class="row-spinner"' not in dom or
              'row-spinner" hidden' in dom)
        print("\nD) cleanup dialog lists what the scan found")
        dom = browser.dom("theme=light&modal=cleanup", 4000)
        # Scoped to the dialog: digest-cell is a shared class (the tables behind
        # the modal use it too), so counting it page-wide made this assertion
        # depend on no other view ever rendering a digest.
        dialog = re.search(r'id="cleanupBody".*?</table>', dom, re.S)
        rows = len(re.findall(r'digest-cell', dialog.group(0))) if dialog else -1
        check("lists one row per untagged artifact", rows == 4, f"{rows} row(s)")
        check("reports scanned repositories from the scan payload",
              "已扫描仓库: 9/9" in dom, "summary missing the scanned count")
        check("reports the reclaimable size", "可回收" in dom)
        check("warns that deletion is a soft delete needing GC", "软删除" in dom)
        check("confirm button reflects the selection count", "清理选中 (4)" in dom)
        # A missing i18n key renders as its literal name in the table header.
        check("no untranslated key in the table header", "cleanup.repository" not in dom)

        print("\nE) with nothing selected, deletion cannot be triggered")
        dom = browser.dom("theme=light&modal=cleanup&uncheckall=1", 4000)
        # Two traps here: --dump-dom serialises HTML attributes, and for a checkbox the
        # `checked` attribute mirrors defaultChecked, not the live state — so counting
        # "checked" strings would assert nothing. The button's state is derived from the
        # live selection, and a marker proves the driver really ran.
        check("the uncheck driver actually ran",
              'data-probe-uncheck="1"' in dom, "driver did not run (marker missing)")
        m = re.search(r'<button class="btn btn-danger" id="btnCleanupConfirm"[^>]*>([^<]*)', dom)
        check("confirm button is disabled", m is not None and "disabled" in m.group(0),
              m.group(0) if m else "button not found")
        check("confirm button no longer shows a count",
              m is not None and "(" not in m.group(1), m.group(1) if m else "")

        print("\nF) the settings panel")
        dom = browser.dom("theme=light&modal=settings", 5000)
        check("the modal opens from the toolbar button", 'id="settingsModal"' in dom and 'id="settingsBody"' in dom)
        # Since v1.5.0 the scanner policy is per project; since v1.7.0 the
        # global panel keeps only the account-level sections (no diagnostics).
        check("global panel keeps users + about, drops scanner & diagnostics",
              all(k in dom for k in ("用户管理", "关于 IMREPO"))
              and "镜像扫描器" not in dom and "扫描数据源" not in dom and "连接诊断" not in dom,
              "a section is present or absent unexpectedly")
        # Match the version by shape (x.y.z), never by a literal prefix — a
        # hardcoded "1.2." broke the moment the plugin moved to 1.3.0.
        check("About shows the plugin version and id",
              bool(re.search(r"\b\d+\.\d+\.\d+\b", dom)) and PLUGIN_ID in dom)
        # The backend always reports the project page now, so the placeholder is
        # only reachable for a fork that has not set one (?nogithub=1).
        check("About links to the project page",
              'href="https://github.com/' in dom and "待补充" not in dom)
        # A fork that has not set a project page gets a placeholder rather than a
        # dead link, so that branch needs its own render to stay covered.
        no_link = browser.dom("theme=light&modal=settings&nogithub=1", 5000)
        check("a missing project page renders a placeholder, not a dead link",
              "待补充" in no_link and "settings.githubSoon" not in no_link)
        check("the settings file path is shown", "settings.json" in dom)
        check("user management offers create / change-password / delete",
              "创建用户" in dom and "修改密码" in dom and "删除" in dom)
        check("an admin sees the set-admin switch on each row",
              "set-switch" in dom and "设为管理员" in dom, "admin toggle missing")
        dom = browser.dom("theme=light&modal=settings&meadmin=0", 6000)
        check("a non-admin sees only their own profile and no create-user",
              "仅显示本人信息" in dom and "developer1" in dom and "创建用户" not in dom
              and "设为管理员" not in dom, "non-admin user panel leaked management UI")

        print("\nF3) the project settings dialog (access level, quota, per-project scanner)")
        dom = browser.dom("theme=light&projectsettings=1", 6000)
        check("the project dialog opens", 'id="projectSettingsBody"' in dom and "访问级别" in dom,
              "dialog did not render")
        check("the access level is a slider, not a checkbox switch",
              "acc-slider" in dom and "私有" in dom and "公开" in dom, "slider missing")
        check("the quota section shows usage against the cap",
              "项目配额" in dom and "已用空间" in dom and "不设限" in dom, "quota section missing")
        check("vulnerability scanning moved into the project dialog",
              "漏洞扫描（本项目）" in dom and "扫描数据源" in dom and "保存项目扫描设置" in dom,
              "per-project scanner section missing")

        print("\nF4) the Harbor apply gate moved with the scanner")
        dom = browser.dom("theme=light&projectsettings=1", 6000)
        m = re.search(r'<button class="btn btn-outline btn-sm" id="btnApplyScanner"[^>]*>', dom)
        check("the Harbor apply button exists in the project dialog", m is not None, "button not found")
        check("...and is disabled while there is nothing to write",
              m is not None and "disabled" in m.group(0), m.group(0) if m else "")
        check("Harbor's live configuration is shown, not guessed",
              "跟随系统默认" in dom and "severity" in dom)

        dom = browser.dom("theme=light&projectsettings=1&armapply=1", 9000)
        check("arming the apply shows the confirmation label",
              "再点一次确认写入" in dom, "the two-step apply did not arm")
        check("...and lists exactly what would be written",
              "auto_scan → true" in dom, "the pending-write summary is missing")

        print("\nF5) the overview tab, the audit logs, and project creation")
        dom = browser.dom("theme=light&overviewtab=1", 6000)
        check("the overview tab shows the totals in the content pane",
              "仓库总览" in dom and "总空间" in dom and "90.1 GB" in dom, "overview totals missing")
        check("the overview tab lists recent + most-pulled projects in the sidebar",
              "最近新建的项目" in dom and "拉取最多的项目" in dom
              and "ov-project-link" in dom, "overview link lists missing")
        check("the pull window selector offers 1/3/7 days",
              "近 1 天" in dom and "近 3 天" in dom and "近 7 天" in dom, "window selector missing")
        check("the selected window shows its pull count", "128" in dom, "pull count missing")
        check("the overview renders storage + pull charts",
              "项目存储分布" in dom and "ov-chart" in dom, "overview charts missing")
        dom = browser.dom("theme=light&overviewtab=1&overviewlink=1", 7000)
        check("clicking an overview link switches to the projects tab and expands the project",
              "最近新建的项目" in dom and "ledger-api" in dom
              and "payments" in dom, "overview link did not locate the project")
        dom = browser.dom("theme=light&openlogs=1", 6000)
        check("the logs modal lists entries with operation badges",
              'id="logsModal"' in dom and "操作日志" in dom
              and "log-op-pull" in dom and "log-op-delete" in dom, "log table missing")
        check("the log scope offers global and the current project",
              "全局" in dom and "payments" in dom, "scope selector missing")
        dom = browser.dom("theme=light&newproject=1", 6000)
        check("the create-project dialog offers name + access slider",
              "新建项目" in dom and 'id="newProjectName"' in dom and "acc-slider" in dom,
              "create dialog missing")
        dom = browser.dom("theme=light&keeptagged=1", 6000)
        check("the breadcrumb project segment is clickable (same color, underlined)",
              'class="crumb-link"' in dom and ">payments</a>" in dom, "crumb link missing")
        check("the list/card view toggle is gone",
              'id="btnCards"' not in dom and 'id="btnList"' not in dom, "toggle still present")

        print("\nF6) a plain Docker Registry v2 shows namespaces as projects")
        dom = browser.dom("theme=light&mode=docker", 6000)
        check("docker-v2 groups the catalog into namespace folders",
              "team-alpha" in dom and "team-beta" in dom and "nginx" in dom,
              "namespace folders missing")
        m = re.search(r'<button[^>]*id="btnNewProject"[^>]*>', dom)
        check("docker-v2 hides the Harbor-only new-project entry",
              m is not None and "hidden" in m.group(0),
              "new-project button not hidden in docker mode")
        dom = browser.dom("theme=light&mode=docker&overviewtab=1", 6000)
        check("docker-v2 overview shows the namespace storage chart",
              "命名空间存储分布" in dom and "ov-chart" in dom, "v2 overview chart missing")
        check("docker-v2 overview has no pull window (no audit log)",
              "近 1 天" not in dom, "pull window leaked into the v2 overview")

        print("\nG) the global settings still save the connection-level policy")
        # The global panel no longer edits scanner values, but the save flow and
        # its round-trip through settings/set must keep working.
        dom = browser.dom("theme=light&modal=settings&confirmsave=1", 6000)
        check("saving reports success", "设置已保存" in dom or "Settings saved" in dom,
              "no saved toast")

        print("\nH) the settings are visible where they matter")
        dom = browser.dom("theme=light&keeptagged=1&protect=ledger-api-2", 5000)
        check("artifacts outside the retention window are marked",
              "超出保留策略" in dom, "no retention marker")
        check("a protected tag is marked on the chip itself",
              "tag-chip mono protected" in dom, "no protected chip")
        check("...and its delete action is visibly blocked",
              'icon-btn danger blocked' in dom, "the delete action is not marked")

        dom = browser.dom("theme=light&modal=cleanup&rules=1", 5000)
        check("the cleanup dialog names the rules that produced the list",
              "保留最近 1 个" in dom and "排除 doc-*" in dom, "no rule summary")
        check("rule-protected rows are offered but disabled",
              dom.count('type="checkbox" disabled') >= 1, "no disabled row")
        check("...with the reason spelled out", "is excluded by rule" in dom or "newest untagged" in dom)
        check("the confirm count only counts the eligible rows",
              "清理选中 (2)" in dom, "the confirm count is wrong")
        check("protected rows are reported in the summary", "受保护: 2" in dom)

        dom = browser.dom("theme=light&modal=vuln&threshold=medium", 5000)
        check("the CVE panel shows the configured threshold", "阈值: medium" in dom, "no threshold line")
        check("...and whether the report reaches it", "已达阈值" in dom or "未达阈值" in dom)
        check("the panel offers a fresh read and a trigger",
              "刷新报告" in dom and "触发扫描" in dom)

        print("\nI) clicking a project folder shows the project-wide image overview")
        dom = browser.dom("theme=light&overview=1", 6000)
        check("the four totals are shown",
              all(k in dom for k in ("镜像数", "总大小", "仓库数", "Tag 数")), "a stat card is missing")
        check("the totals come from the aggregated payload",
              '>10</span>' in dom and "3.6 GB" in dom, "totals do not match the mock data")
        check("the table is image-first: no tag column", "<th>Tag</th>" not in dom,
              "a tag column leaked into the overview")
        check("a chart-typed image is labelled", "CHART" in dom, "non-IMAGE type badge missing")
        check("rows offer rename + vuln instead of pull/layers",
              'aria-label="重命名 Tag"' in dom and 'aria-label="漏洞"' in dom
              and 'aria-label="拉取命令"' not in dom and 'aria-label="镜像层"' not in dom)
        check("a tag-count column is shown", "<th>Tag 数</th>" in dom, "no tag-count column")
        check("architectures render as one badge per arch",
              "arch-badge" in dom and "amd64" in dom and "arm64" in dom, "arch badges missing")
        check("the repository name is a way into the repository view", "repo-link" in dom,
              "no clickable repository link")

        print("\nJ) a v2 tag table lazily shows each tag's architectures")
        dom = browser.dom("theme=light&mode=docker", 8000)
        check("the tag table opens under a namespace",
              "team-alpha" in dom and "tag-chip" in dom, "tag table missing")
        check("each tag shows its arch badges",
              "arch-badge" in dom and "amd64" in dom and "arm64" in dom, "tag arch badges missing")
        # Same lazy read answers the digest: a v2 tags/list carries only names.
        check("each tag shows its digest too", "digest-cell" in dom and "sha256:" in dom,
              "no digest in the v2 tag table")

        print("\nK) switching connection drops the previous registry's view")
        # The host fires onContext at t=1.5s, then the driver re-opens the first
        # project/namespace and its first repository. Nothing cached may cross over.
        dom = browser.dom("theme=light&probe=1&mode=docker&switchconn=1", 9000)
        check("the driver's connection switch actually fired",
              'data-probe-switch="1"' in dom, "onContext callback missing (marker absent)")
        reqs = probe_requests(dom)
        at = reqs.index("ctx:switch") if "ctx:switch" in reqs else len(reqs)
        before, after = reqs[:at], reqs[at + 1:]
        check("the new connection is bootstrapped (registry info re-read)",
              "registry/info" in after, f"after the switch: {after[:10]}")
        # Same repository, same tag, twice in one session — but across two
        # connections, so the answer must not be reused.
        arch = [r for r in after if r.startswith("registry/arches:")]
        check("the same tag's architectures are read again on the new connection",
              bool(arch) and any(r in before for r in arch),
              f"before: {before[-4:]} / after: {after[:10]}")
        check("the workbench recovered: the re-opened repository renders",
              "tag-chip" in dom and "2026-09-22_141718" in dom,
              "the tag table did not come back after the switch")

        dom = browser.dom("theme=light&probe=1&switchconn=1&noredrill=1", 6000)
        check("the previous connection's content pane is emptied",
              "连接一个镜像仓库以开始浏览" in dom, "the stale view is still on screen")
        check("...and no artifact of the previous connection is left",
              f"{SLOW}-1" not in dom, "an artifact from the old connection survived")
        check("the breadcrumb is cleared", 'id="crumbs"></div>' in dom,
              "the breadcrumb still points somewhere")
        check("the new connection's project list is rendered",
              "payments" in dom and "ddf" in dom, "the tree was not re-bootstrapped")

        print("\nL) concurrent architecture reads are deduplicated")
        # ?slowarches keeps the reads in flight, ?reclick renders the same table a
        # second time while they are: one request per tag must be issued, not two.
        dom = browser.dom("theme=light&probe=1&mode=docker&slowarches=1500&reclick=1", 9000)
        arches = [r for r in probe_requests(dom) if r.startswith("registry/arches")]
        check("the tag table read its architectures", len(arches) >= 3, f"requests: {arches}")
        check("one architecture read per tag, even after a second render",
              len(arches) == len(set(arches)), f"duplicate reads: {arches}")

        print("\nM) the Harbor tag table shows a digest and the architectures")
        # Both fields had to be added to the artifacts payload, and this is the
        # test that would have caught their absence: the table rendered badges
        # from `arches`, which the backend never sent, while the project overview
        # (a different struct) worked — so it looked like a styling quirk in one
        # table rather than a missing field. The fixture mirrored the omission.
        dom = browser.dom("theme=light&probe=1", 6000)
        check("the tag table heads a digest column", "Digest" in dom, "no digest column")
        check("a tag row shows its digest", "digest-cell" in dom and "sha256:" in dom,
              "no digest in the row")
        check("a tag row shows one badge per architecture",
              "arch-badge" in dom and "amd64" in dom and "arm64" in dom,
              "no architecture badges in the Harbor tag table")
        # One fixture row carries no platform information, the way a single-arch
        # image or an older Harbor does not. Its badges have to come from reading
        # the manifest — badges that only appear when the server volunteers the
        # data are badges that vanish in the field.
        check("a row with no platform in the payload is read from the manifest",
              any(r.startswith("registry/arches") for r in probe_requests(dom)),
              f"no fallback read: {probe_requests(dom)[:8]}")

        print("\nM9) the GC section reads and edits Harbor's schedule")
        dom = browser.dom("theme=light&modal=settings", 7000)
        check("the settings panel has a GC section", "镜像回收" in dom or "garbage collection" in dom,
              "no GC section")
        check("it shows what is scheduled now",
              "0 0 0 * * *" in dom and ("下次执行" in dom or "Next run" in dom),
              "the current schedule is not shown")
        check("it offers a schedule type and a concurrency control",
              "gc-row" in dom and "1-10" in dom, "controls missing")
        check("it offers a manual run", ("立即执行 GC" in dom or "Run GC now" in dom))
        # The four schedule facts share one row: labels in a header row, values
        # beneath, status coloured. Checked structurally — a screenshot shows the
        # layout but cannot fail a build.
        facts = re.search(r'class="gc-facts"(.*?)</div>', dom, re.S)
        seg = facts.group(1) if facts else ""
        labels = re.findall(r'class="k"[^>]*>([^<]*)<', seg)
        check("the schedule facts are one labelled row of four",
              # The DOM carries "Cron"; the uppercase look comes from CSS.
              labels == ["计划类型", "Cron 表达式", "下次执行", "上次状态"], labels)
        check("the status is coloured, not just written",
              "gc-ok" in seg or "gc-bad" in seg, "no status colour class")
        check("the status cell carries the value itself",
              re.search(r'class="v mono[^"]*"[^>]*>Success<', seg) is not None, seg[-160:])
        check("the parameters are not repeated above the form that edits them",
              "同时回收无 Tag 的镜像: " not in seg)

        dom = browser.dom("theme=light&modal=settings&gcnone=1", 7000)
        check("an unconfigured registry says so instead of erroring",
              ("尚未配置" in dom or "No GC schedule" in dom), "no empty state")

        print("\nM8) deleting a tag re-reads the counts the tree shows")
        # Reported from use: after deleting a tag the sidebar kept its old number,
        # and leaving the project and coming back showed the same one — the
        # repository listing was still the cached copy, and only the artifact
        # listing had been invalidated.
        dom = browser.dom("theme=light&probe=1&modal=delete&confirmdelete=1", 9000)
        reqs = probe_requests(dom)
        listing_reads = [r for r in reqs if r.startswith("harbor/repositories")]
        check("the delete completed", any(r.startswith("harbor/deleteTag") for r in reqs) or
              any(r.startswith("registry/delete") for r in reqs), f"requests: {reqs[-8:]}")
        check("the repository listing is re-read after the deletion",
              len(listing_reads) >= 2,
              f"listing read {len(listing_reads)} time(s): {listing_reads}")
        # And the number the user actually looks at has moved: the fixture counts
        # down on a delete, so a stale tree would still show the old value.
        row = re.search(r'tree-item lvl2[^>]*>.*?ledger-api.*?class="meta">(\d+)<', dom, re.S)
        shown = row.group(1) if row else None
        check("the count beside the repository reflects the deletion",
              shown == "4", f"tree shows {shown!r}, expected the decremented count")

        print("\nM7) the layers dialog names the platform, or says it does not know")
        # Reported from use: the platform line read "/" — the parts were joined
        # with a slash even when both were missing.
        dom = browser.dom("theme=light&modal=layers", 6000)
        check("the platform is shown as os/arch when known",
              "linux/amd64" in dom, "platform line missing or malformed")
        dom = browser.dom("theme=light&modal=layers&layersnoplatform=1", 6000)
        # Read the line itself. A looser "no slash nearby" check passed with the
        # bug still in place, which is worse than no check at all.
        line = re.search(r"(平台|Platform)\s*:\s*([^<]*)", dom)
        shown = (line.group(2) if line else "").strip()
        check("an unknown platform reads as a dash, never a bare slash",
              shown == "—", f"platform line rendered as {shown!r}")

        print("\nM6) the audit log filters and paginates")
        def log_dom(query):
            page = browser.dom(query, 7000)
            body = re.search(r'id="logsBody".*?(?=<div class="modal-footer")', page, re.S)
            seg = body.group(0) if body else ""
            return seg, seg.count("<tr>")

        # Scope: the dialog opens on the current project; 全部 must return more.
        scoped, scoped_rows = log_dom("theme=light&openlogs=1")
        everything, all_rows = log_dom("theme=light&openlogs=1&logscope=all")
        check("the default view is scoped to the current project",
              "第 1 /" in scoped or "Page 1 of" in scoped, "no pager shown")
        check("choosing everything returns more rows than the project view",
              all_rows > scoped_rows, f"all={all_rows} vs scoped={scoped_rows}")

        # Operation filter: must change what comes back.
        pulls, pull_rows = log_dom("theme=light&openlogs=1&logscope=all&logop=pull")
        check("filtering by operation narrows the list",
              0 < pull_rows < all_rows, f"operation=pull gave {pull_rows} of {all_rows}")
        check("...and every row is that operation",
              "log-op-pull" in pulls and "log-op-push" not in pulls,
              "rows of other operations survived the filter")

        # Pagination: size selector, real page count, and a jump box.
        check("the pager shows the page size selector", "set-select" in scoped)
        check("the pager reports a real page count from the server total",
              "共" in scoped or "entries" in scoped, "no total shown")
        check("the pager offers a jump box", "pager-jump" in scoped)

        print("\nM5) opening a repository from the content pane expands the tree")
        # Reported from use: with the project collapsed, clicking an image on the
        # right showed the tag page while the tree stayed shut — the highlighted
        # row was inside the collapsed folder, so there was no sign of where you
        # were.
        dom = browser.dom("theme=light&overview=1&collapsethenopen=1", 9000)
        tree = re.search(r'id="tree"(.*?)</nav>', dom, re.S)
        segment = tree.group(1) if tree else ""
        check("the project is expanded again in the tree",
              "ledger-api" in segment and "tree-item lvl2" in segment,
              "the tree did not expand after opening a repository from the content pane")
        check("...and the opened repository is the highlighted row",
              'class="tree-item lvl2 active"' in segment,
              "no active repository row in the tree")

        print("\nM4) the audit-log scope filter actually scopes")
        # Reported from use: "current project" and "all" showed the same rows.
        # Harbor's audit-log endpoint takes only q/sort/page/page_size, so the
        # project_id parameter the plugin sent was ignored and nothing filtered.
        def log_rows(query):
            page = browser.dom(query, 7000)
            body = re.search(r'id="logsBody".*?</table>', page, re.S)
            return body.group(0).count("<tr>") if body else -1

        # The dialog opens scoped to the current project (that is its default),
        # so "everything" has to be asked for explicitly.
        scoped = log_rows("theme=light&openlogs=1")
        everything = log_rows("theme=light&openlogs=1&logscope=all")
        # Compared against each other, not against fixture lengths: the point is
        # that the two scopes return different amounts, which is what was broken.
        check("the default view is scoped to one project, not everything",
              0 < scoped < everything, f"{scoped} of {everything} rows as the default")
        check("choosing all rows returns strictly more than the project view",
              everything > scoped, f"all={everything} vs scoped={scoped}")

        print("\nM3) the sticky table header leaves no gap above it")
        # Reported from use: with the dialog scrolled, rows that had scrolled past
        # stayed visible through a strip above the header. A sticky element pins to
        # the CONTENT box, so the scroll container's top padding was left uncovered.
        dom = browser.dom("theme=light&openlogs=1&logscroll=260&stickycheck=1", 8000)
        m = re.search(r'data-sticky-gap="(-?\d+)"', dom)
        check("the probe measured the header", m is not None, "sticky probe did not run")
        if m:
            gap = int(m.group(1))
            check("the header sits flush with the top of the scrolled dialog",
                  gap <= 0,
                  f"header sits {gap}px below the top edge — a strip of scrolled rows shows through it")

        print("\nM2) toggling an admin switch does not stack another user table")
        # Reported from use: each click on the admin checkbox appended a fresh
        # copy of the whole section, so the panel grew by one table per click.
        # The renderer appended its box without removing the previous one.
        dom = browser.dom("theme=light&modal=settings&admintoggles=3", 9000)
        boxes = dom.count('class="user-box"')
        forms = dom.count('class="user-create"')
        tables = dom.count('class="table admin-table"')
        check("the toggle driver actually ran",
              'data-probe-toggle="missing"' not in dom, "driver found no switch to click")
        check("three admin toggles leave exactly one user panel",
              boxes == 1, f"{boxes} user-box block(s) in the panel")
        check("...one create-user form", forms == 1, f"{forms} create form(s)")
        check("...and one user table", tables == 1, f"{tables} user table(s)")

        print("\nN) architectures survive leaving a repository and coming back")
        # Reported from use: the badges were there on first view and gone after
        # switching to another image and back. The paint was guarded by
        # slot.isConnected, and a cache hit — every visit after the first —
        # resolves without suspending, so it ran before the caller had attached
        # the slot. A guard meant to skip detached nodes skipped the live one.
        dom = browser.dom("theme=light&revisit=1", 8000)
        check("the workbench is back on the first repository",
              "ledger-api-1" in dom and "docs-api-1" not in dom,
              "the revisit driver did not end up where expected")
        # Counted, not just "some badge exists": only the rows whose payload
        # carries no `arches` go through the lazy read, and the first two rows
        # render their badges straight from the fixture — so a loose assertion
        # passes while the third row silently loses its badges. Three rows, two
        # architectures each.
        badges = dom.count('class="arch-badge mono"')
        check("every row still shows both architectures after returning",
              badges == 6, f"{badges} badge(s) on screen, expected 6")

    except BrowserStalled as stalled:
        sys.exit(f"UI harness failed: {stalled}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return _reporter.report()


if __name__ == "__main__":
    raise SystemExit(main())
