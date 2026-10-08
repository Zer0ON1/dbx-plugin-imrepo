# Changelog

Notable changes per release. Versions follow the plugin id
`com.leavingrain.imrepo`; packages are named
`com.leavingrain.imrepo-<version>-<target>.dbxp`.

## Unreleased

**AI assistant tools.** The plugin now exposes nine MCP tools to DBX's built-in
assistant, behind the opt-in switch in the plugin centre. Five read (projects,
repositories, tags, one image, vulnerability report) and four write (create
project, project visibility, rename tag, delete tag).

The design decision worth recording is that every tool drives the *same* backend
function the workbench calls. A second implementation would have quietly bypassed
the retention policy and the delete re-check — and the docs are explicit that the
host's confirmation prompt guards against a model acting by mistake, and "cannot
replace the plugin's own safety rules". So a protected tag still cannot be deleted
through this path, and the test asserts on the requests: no DELETE is sent at all.

Reads carry `readOnlyHint` and run directly; writes always pause for the operator.
`external_tools` stays false, so nothing is published to external MCP clients.


**The GC schedule reads as one line.** Type, cron, next run and last status were
scattered key/value pairs in an auto-fitting grid; they now sit in four equal
columns with their labels above them, and the last status is coloured — green
when the run succeeded, red when it did not. The two remaining parameters are no
longer repeated above the form that edits them.

## 0.1.4

**The audit-log scope and operation filters did nothing.** Harbor's audit-log
endpoint takes only `q`/`sort`/`page`/`page_size`: its swagger lists those four
and `ListAuditLogs` reads only `Q`. The plugin sent `project_id` and `operation`
as top-level parameters, which Harbor accepts and ignores, so every filter
looked inert. Both now travel inside `q`, comma separated. Measured against a
live Harbor: `operation=pull` returned the unfiltered 172,173 rows while
`q=operation=pull` returned 139,738.

The same mistake was in the overview's pull counts and most-pulled ranking,
which had been counting *every* audit entry in the window rather than pulls.
That one nobody had reported; the fixture was corrected first, and the numbers
moved.

**The layers dialog showed the platform as a bare "/".** The two parts were
joined with a slash whether or not they existed. A single-arch manifest carries
no platform — only a manifest list does — so the backend now reads it from the
config blob, which it was already fetching, and the dialog prints a dash rather
than a slash when it genuinely does not know.

**Deleting a tag left the tree's counts stale.** The counts beside each
repository come from the repository listing, and a mutation invalidated only the
artifact listing — so the sidebar kept the pre-delete numbers, and leaving the
project and returning within the cache window served that same listing again.
Mutations now re-read it.

**Log dialog: page size, real page count, and a jump box.** The pager could only
step forward blindly; a full page and the last page looked identical. Harbor
reports the total in `X-Total-Count`, so the dialog now shows "page N of M",
lets you pick 20/50/100 rows, and jump to a page. The dialog is wider so
time/operation/resource/user fit on one line.

**New: registry garbage collection.** Settings gains a GC section for Harbor:
what is scheduled now (type, cron, next run, last status, parameters), editing
it, and a two-step "run GC now". This is Harbor's own GC — the untagged cleanup
deletes artifacts, and GC is what reclaims the blobs those deletions orphan.

## 0.1.3

**Architecture badges disappeared on the second visit to a repository.** First
view was fine; switch to another image and back and they were gone.

The lazy read was guarded by `slot.isConnected`, and the guard rejected exactly
the case it was meant to allow. A cache hit resolves without ever suspending, so
the function completed before the caller had appended the slot — and every table
here builds a row detached and attaches it afterwards, which is the normal way to
build one. On a cache miss the await gave the caller time to attach, so the first
visit painted and every later one did not.

The read now paints unconditionally; a slot that has since been detached is
simply no longer displayed. Covered by a test that leaves a repository and comes
back and counts the badges, because the rows whose payload already carries
architectures render theirs directly — a looser assertion passed while the lazy
row silently lost its badges.

**Admin toggles stacked copies of the user panel.** Every mutation re-entered the
renderer to refresh the table, and the renderer appended its box without removing
the previous one — so each click on an admin switch, each user created, each user
deleted added another whole section.

**The dialog's table header showed rows through it while scrolling.** A sticky
element is pinned to the content box, so the scroll container's own top padding
was left uncovered, and rows scrolling past stayed visible in that strip. The
sections that hold tables now declare their top padding (`--im-scroll-pad-top`)
and the header offsets by it; the content pane had the same defect, one of the
two places this could hide.

**The audit-log scope filter did nothing.** Harbor's audit-log endpoint takes
only `q`/`sort`/`page`/`page_size` — there is no `project_id` parameter (its
swagger and `ListAuditLogs`, which reads only `Q`). The plugin sent a top-level
`project_id`, which Harbor ignores in silence, so "current project" and "all"
returned the same rows. Project scoping now goes through the `q` filter.

> The test covering this asserted the parameter the plugin sent, not the one
> Harbor reads — it required `project_id=1` in the request, so it passed for as
> long as the feature was broken. It now parses the query and requires
> `q=project_id=N`.

**Opening a repository from the content pane left the tree collapsed.** The row
that carries the highlight is rendered by the expanded project, so with the tree
shut there was no sign of which repository was open. Opening a repository now
expands its project first, fetching the repository list only when the collapse
had discarded it.

### 发版时值得一并说明的平台验证

本版本发布时，插件已在三台**实体机**上安装使用过：**麒麟 V10 aarch64、openEuler 24.03 amd64、
Windows 11 Enterprise**（此前 0.1.2 的 Release Notes 只提到了麒麟 V10 上的 arm64 复验）。
Release Notes 里可以如实写这一条——它比"CI 跑过"更有说服力，因为那是真实发行版上的实际使用。
## 0.1.2

Everything here came from using the plugin against a real Harbor rather than the
test fixture — which is where the assumptions broke.

**Fixed from a Linux run:**

- **Filled buttons went blank on hover.** `.btn:hover` (specificity 0,2,0)
  outranked `.btn-primary` (0,1,0), so the neutral hover grey won and painted
  under white text — a ratio of 1.14. The contrast gate now walks the class
  combinations the UI uses, applies the same cascade the browser does, and
  measures state pairs; it had only ever compared static token pairs.
- **The logo did not render.** The sandbox CSP is `img-src data: blob:`, so an
  `<img>` pointing at the plugin's own asset was blocked outright. The mark is
  inline SVG now, which is not an image load and needs no permission.
- **Harbor's tag table showed no architectures.** Its list endpoint reports
  `platform: null` and no `references` for the artifacts this server holds —
  verified against a running Harbor. The table now reads the manifest per tag
  (one cached request, the path the v2 table already used) instead of depending
  on the list payload.
- **Each tag shows its sha256.** Harbor already sent the digest; a v2 tags/list
  does not, so the digest rides along with the manifest read above.
- **A catch-all 200 was mistaken for Harbor.** Auto-detection rested on the
  status code, so a registry behind a gateway that answers 200 to unknown paths
  was switched into Harbor mode: the badge read "harbor" while every Harbor call
  then failed. Harbor's endpoint answers the literal string "Pong"; detection
  now checks the body.

**Changed:**

- Harbor-only entries are hidden on other registry types rather than shown
  disabled, and the new-project action moved into the sidebar on the same line
  as the resource list, aligned with the per-row settings gears.
- The support matrix in the README states what each registry type can and cannot
  do, with reasons — including the one that is a protocol limit rather than a
  gap: untagged cleanup cannot exist on plain v2, because `catalog`/`tags` only
  expose manifests that carry tags.

## 0.1.1

**The plugin itself is unchanged** — the packaged manifest, UI and sidecar are
identical to 0.1.0 apart from the version string. The release exists because
0.1.0 could not be validated: its CI runs failed in the test harness (a Windows
console that cannot print the arrows the suites use, and a macOS path assumption
in one settings assertion), so only Linux had actually been exercised, and its
tag was locked against being moved once the release was published. Publishing
the same plugin from a commit whose Windows and macOS runs pass is the honest
fix; rewriting a published tag is not.

What changed around the plugin:

- The test harness runs on all three platforms: stdout is forced to UTF-8, and
  the credentials check derives the config directory from the sidecar instead of
  rebuilding a path that only holds on two of the three.
- Every CI runner installs the same `chrome-headless-shell` instead of borrowing
  the host's Chrome or Edge, where a full browser under `--headless=new` wrote
  no DOM and never exited. The UI suite now fails rather than skips when no
  browser is present, and validates the DOM it gets — an empty document would
  have satisfied every "X is not in dom" assertion.
- New gate: `tools/check-browser-baseline.py` holds the UI to **Chrome 109**,
  DBX's oldest supported engine. CSS has no feature detection, so a newer
  property is dropped silently on an older one.
- The CI matrix builds once and tests the same artifacts on ubuntu, windows and
  macOS; the Go and npm caches are actually enabled (both were silently off).

## 0.1.0

The first public release. It is the codebase that internal iteration had taken
to 1.8.0, renumbered: nothing from that counter was ever published, so the
public history starts at 0.1.0 rather than inheriting a version number that
implies nine releases nobody could download. The internal milestones are kept
further down, because they explain why the code looks the way it does.

**Docker Registry v2 gains project management.** A v2 registry has no project
object — the only structure it exposes is repository names — so the first path
segment of each repository is used as its namespace, with flat names becoming
single-repository projects. New `registry/namespaces`, `registry/repositories`,
`registry/images` and `registry/overview` RPCs back a namespace tree, a
namespace overview (image and size totals, deduplicated by manifest digest) and
registry-wide counts.

**The Overview tab draws charts.** A pure-SVG horizontal bar chart (built with
DOM APIs and `textContent`, so registry-supplied names cannot inject markup)
shows the most-pulled projects and the storage distribution per project on
Harbor, and the storage distribution per namespace on v2.

**Architectures are shown as one circle each.** Multi-arch images list every
platform they contain, parsed from the manifest list's entries (attestation
entries with `unknown/unknown` are skipped) or, for a single-arch manifest, from
its config blob. Harbor answers from the artifact directly; plain v2 registries
need a `registry/arches` round-trip, so those badges load lazily and are cached.

**Packaging covers every platform from one machine.** `tools/build-packages.py`
cross-compiles windows/linux/darwin for x64 and arm64 with a statically linked
sidecar, rewrites the manifest's backend path per target, and emits the
`release-candidates.json` that dbx-store's auto-update workflow reads. This
replaces the previous arrangement, under which the Windows package could only be
produced by the official CLI on Windows and the Linux ones were assembled by a
separate script that failed to rewrite the manifest — so the host had no
executable to launch. The `bin/<target>/` path is now asserted by the test
suite.

**Fixed before publishing:**

- The architecture cache was keyed by repository and tag with no connection, so
  switching registries served the previous registry's platforms.
- Switching connections cleared only the fetch cache: the project tree,
  breadcrumb and content pane kept describing the registry just left.
- The layers and cleanup dialogs had no race guard, so a slow read for
  repository A could paint into a dialog reopened on B.
- `index.html` asked for a translation key that does not exist, and `t()` falls
  back to returning the key — the hint rendered as the literal string
  `project.accessDesc`. `tools/check-i18n.py` now gates that whole class.
- The repository URLs in the manifest (`github.com/dbx/...`) were never real.

Reported assertion counts: settings 143, UI 85, layers 23, cleanup 21, retag 17,
plus the WCAG contrast gate and the translation gate. The sidecar suites were
also run against the linux-arm64 package on Kylin V10 aarch64 hardware (glibc
2.28).

## Earlier internal iterations

Never published. Kept as history: each one explains a decision that is still
visible in the code, and several document a bug whose fix looks arbitrary
without the story.

### 1.7.0

Overview moved into a left sidebar tab: recently created projects, most-pulled
projects, and a statistics pane. Linux builds became statically linked so they
run on older enterprise distributions (Kylin V10 and similar, glibc 2.28).

### 1.6.0

**Fixed: connection fields were never read.** The host delivers `config`-bound
fields in `connection.external_config` and `secret`-bound fields in
`connection.connection_secrets`, not the literal `config`/`secret` keys the
plugin was reading. Every symptom followed from that one mistake — the registry
type fell back to `docker-v2`, authentication to `basic`, and the password was
always empty. Both shapes are now accepted.

### 1.5.0

Project lifecycle: create project, per-project storage quota, audit logs,
registry-wide overview, per-project vulnerability-scanner policy.

### 1.4.0

Project administration and user management (members and roles, retention
policies, users, passwords, admin toggles), all reading current state before
writing so unrelated metadata survives.

### 1.3.0

Per-project settings entry, HTTP/HTTPS selection, no-auth connections, and
concurrent artifact fetching.

### 1.2.0

First working build: connection presets, OCI and Harbor browsing, tag rename and
delete, manifest layer analysis, vulnerability reports, pull-command generator,
untagged-artifact cleanup, and the backend-enforced settings model.
