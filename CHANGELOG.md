# Changelog

Notable changes per release. Versions follow the plugin id
`com.dbx.plugin.imrepo`; packages are named
`com.dbx.plugin.imrepo-<version>-<target>.dbxp`.

## 1.8.0

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

Reported assertion counts: settings 143, UI 75, layers 23, cleanup 21,
retag 17, plus the WCAG contrast gate.

## 1.7.0

Overview moved into a left sidebar tab: recently created projects, most-pulled
projects, and a statistics pane. Linux builds became statically linked so they
run on older enterprise distributions (Kylin V10 and similar, glibc 2.28).

## 1.6.0

**Fixed: connection fields were never read.** The host delivers `config`-bound
fields in `connection.external_config` and `secret`-bound fields in
`connection.connection_secrets`, not the literal `config`/`secret` keys the
plugin was reading. Every symptom followed from that one mistake — the registry
type fell back to `docker-v2`, authentication to `basic`, and the password was
always empty. Both shapes are now accepted.

## 1.5.0

Project lifecycle: create project, per-project storage quota, audit logs,
registry-wide overview, per-project vulnerability-scanner policy.

## 1.4.0

Project administration and user management (members and roles, retention
policies, users, passwords, admin toggles), all reading current state before
writing so unrelated metadata survives.

## 1.3.0

Per-project settings entry, HTTP/HTTPS selection, no-auth connections, and
concurrent artifact fetching.

## 1.2.0

First working build: connection presets, OCI and Harbor browsing, tag rename and
delete, manifest layer analysis, vulnerability reports, pull-command generator,
untagged-artifact cleanup, and the backend-enforced settings model.
