# Changelog

Notable changes per release. Versions follow the plugin id
`com.leavingrain.imrepo`; packages are named
`com.leavingrain.imrepo-<version>-<target>.dbxp`.

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
