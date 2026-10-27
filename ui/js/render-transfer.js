/* IMREPO workbench — image archive upload / download (.tar / .tar.gz).
 *
 * The archive never passes through the UI as one blob: the sidecar receives /
 * serves it in 4 MiB chunks, and a desktop host writes those chunks straight to
 * a file the user picked. When the host has no fileTransfer bridge (older
 * desktop builds, web hosts) the browser file picker / a Blob download stands
 * in for the same steps.
 *
 * Classic script, not an ES module: every file hangs its exports on the shared
 * window.IMREPO namespace (IM here).
 */
(function (IM) {
  "use strict";

  const CHUNK = 4 * 1024 * 1024;
  const REPO_RE = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/;
  const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

  IM.transferState = { upload: null, download: null };

  function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (m, key) =>
      (values[key] == null ? m : String(values[key])));
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function hostFileTransfer() {
    const bridge = window.dbxPlugin;
    return bridge && bridge.fileTransfer ? bridge.fileTransfer : null;
  }

  function bytesToBase64(bytes) {
    let out = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(out);
  }

  function base64ToBytes(text) {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function progressPct(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round(done * 100 / total)));
  }

  function setBar(bar, pct) {
    if (!bar) return;
    bar.style.width = pct + "%";
    bar.parentNode.setAttribute("role", "progressbar");
    bar.parentNode.setAttribute("aria-valuenow", String(pct));
    bar.parentNode.setAttribute("aria-valuemin", "0");
    bar.parentNode.setAttribute("aria-valuemax", "100");
  }

  function setStatus(node, text) {
    if (!node) return;
    node.textContent = text || "";
    node.hidden = !text;
  }

  function showWarning(node, text) {
    if (!node) return;
    node.textContent = text || "";
    node.hidden = !text;
  }

  // Read-only fact values are ellipsized when long; the tooltip keeps the
  // full value reachable without making the field editable.
  function setFact(id, value) {
    const node = IM.$("#" + id);
    if (!node) return;
    const text = value || "—";
    node.textContent = text;
    node.title = value ? text : "";
  }

  // The sidecar reports phases as short stable tokens ("layer 2/4"); the
  // dialog translates them instead of showing the token to a Chinese user.
  function phaseLabel(phase) {
    const text = String(phase || "");
    if (text === "hashing") return IM.t("upload.phaseHashing");
    if (text === "config") return IM.t("upload.phaseConfig");
    if (text === "manifest") return IM.t("upload.phaseManifest");
    if (text === "reading manifests") return IM.t("upload.phaseReading");
    if (text.indexOf("layer ") === 0) return fill(IM.t("upload.phaseLayer"), { n: text.slice(6) });
    if (text.indexOf("blob ") === 0) return fill(IM.t("upload.phaseBlob"), { n: text.slice(5) });
    if (text.indexOf("manifest ") === 0) return fill(IM.t("upload.phaseManifests"), { n: text.slice(9) });
    return text;
  }

  // Split the archive's source reference into the fields the dialog shows.
  // Docker calls the part after the colon the tag; the registry and repository
  // are the two other parts of the reference, and the dialog keeps all three
  // read-only so a pasted/edited name cannot silently change the image identity.
  function splitSourceRef(image) {
    const first = ((image && image.refs) || [])[0] || "";
    let ref = String(first).replace(/^[a-z]+:\/\//i, "").replace(/^\/+/, "");
    const at = ref.indexOf("@");
    if (at >= 0) ref = ref.slice(0, at);
    let tag = (image && image.suggestedTag) || "";
    const lastSlash = ref.lastIndexOf("/");
    const lastColon = ref.lastIndexOf(":");
    if (lastColon > lastSlash) {
      if (!tag) tag = ref.slice(lastColon + 1);
      ref = ref.slice(0, lastColon);
    }
    let site = "";
    let path = ref;
    const slash = ref.indexOf("/");
    // A bare "v1" carried by an OCI index annotation is a tag, not a repository.
    const bareTag = slash < 0 && tag && ref === tag && !(image && image.suggestedRepository);
    if (bareTag) {
      path = "";
    } else if (slash > 0) {
      const firstPart = ref.slice(0, slash);
      if (firstPart.indexOf(".") >= 0 || firstPart.indexOf(":") >= 0 || firstPart === "localhost") {
        site = firstPart;
        path = ref.slice(slash + 1);
      }
    }
    if (!path && image && image.suggestedRepository) path = image.suggestedRepository;
    let project = "";
    let repo = path;
    const i = path.indexOf("/");
    if (i > 0) { project = path.slice(0, i); repo = path.slice(i + 1); }
    if (!tag) tag = (image && image.suggestedTag) || "";
    return { site, project, repo, tag };
  }

  function platformText(p) {
    if (!p || !p.os) return "—";
    return p.os + "/" + p.architecture + (p.variant ? "/" + p.variant : "");
  }

  function updateUploadTargetRef(st) {
    const node = IM.$("#uploadTargetRef");
    if (!node || !st) return;
    const tag = IM.$("#uploadTag").value.trim();
    const host = IM.registryHost();
    let ref = host ? host + "/" + st.targetRepo : st.targetRepo;
    if (tag) ref += ":" + tag;
    node.textContent = fill(IM.t("upload.targetRef"), { ref: ref || "—" });
  }

  /* --------------------------------------------------------------------- */
  /* Upload                                                                */
  /* --------------------------------------------------------------------- */

  IM.openUpload = function openUpload() {
    const existing = IM.transferState.upload;
    if (existing) {
      if (existing.busy) IM.toast(IM.t("upload.busy"), "warn");
      return;
    }
    if (!IM.state.current.repo) {
      IM.toast(IM.t("upload.needRepo"), "warn");
      return;
    }
    const harbor = IM.state.mode === "harbor";
    let project = harbor ? (IM.state.current.project || "") : "";
    const full = IM.state.current.repo || "";
    let short = harbor ? IM.stripProjectPrefix(full, project) : full;
    if (harbor && !project) {
      const slash = full.indexOf("/");
      if (slash > 0) { project = full.slice(0, slash); short = full.slice(slash + 1); }
    }
    IM.transferState.upload = {
      id: null, cancelled: false, busy: false, parsed: false,
      status: null, imageIndex: 0, harbor,
      targetProject: project,
      targetShort: short,
      targetRepo: harbor ? (project ? project + "/" + short : short) : full,
    };
    IM.resetUploadForm();
    IM.$("#uploadModal").hidden = false;
  }

  IM.resetUploadForm = function resetUploadForm() {
    const pick = IM.$("#btnPickArchive");
    if (pick) pick.disabled = false;
    IM.$("#uploadFileName").textContent = IM.t("upload.noFile");
    IM.$("#uploadProgress").hidden = true;
    IM.$("#uploadDetails").hidden = true;
    IM.$("#uploadWarning").hidden = true;
    IM.$("#uploadWarning").textContent = "";
    setBar(IM.$("#uploadBar"), 0);
    setStatus(IM.$("#uploadStatusText"), "");
    IM.$("#btnUploadPush").disabled = true;
    IM.$("#uploadImageField").hidden = true;
    IM.$("#uploadImage").innerHTML = "";
    ["uploadSourceSite", "uploadSourceProject", "uploadSourceRepo", "uploadSourceVersion",
     "uploadSourceFormat", "uploadSourceLayers", "uploadSourceSize"].forEach((id) => setFact(id, ""));
    const arch = IM.$("#uploadSourceArch");
    arch.textContent = "—";
    arch.title = "";
    setFact("uploadTargetProject", "");
    setFact("uploadTargetRepo", "");
    IM.$("#uploadTag").value = "";
    IM.$("#uploadTargetRef").textContent = "";
  }

  IM.closeUpload = async function closeUpload(silent) {
    const st = IM.transferState.upload;
    if (!st) return;
    const wasBusy = st.busy;
    st.cancelled = true;
    const id = st.id;
    st.id = null;
    IM.transferState.upload = null;
    IM.$("#uploadModal").hidden = true;
    if (!silent) {
      IM.resetUploadForm();
      if (wasBusy) IM.toast(IM.t("upload.cancelled"), "warn");
    }
    if (id) {
      try { await IM.invoke("transfer/uploadClose", { id }); } catch (_) {}
    }
  }

  IM.pickArchive = async function pickArchive() {
    const st = IM.transferState.upload;
    if (!st || st.busy || st.parsed) return;
    st.busy = true;
    st.cancelled = false;
    IM.$("#btnPickArchive").disabled = true;
    try {
      const picked = await chooseArchive();
      if (!picked || st.cancelled) {
        // The dialog may have been closed while the native picker was open;
        // release the handle the host just handed us.
        if (picked && picked.kind === "host") {
          const bridge = hostFileTransfer();
          if (bridge && typeof bridge.cancel === "function") {
            try { await bridge.cancel(picked.handleId); } catch (_) {}
          }
        }
        st.busy = false;
        IM.$("#btnPickArchive").disabled = false;
        return;
      }
      await uploadArchive(st, picked);
    } catch (e) {
      if (!st.cancelled) {
        showWarning(IM.$("#uploadWarning"), e.message || IM.t("upload.failed"));
        IM.toast(e.message || IM.t("upload.failed"), "err");
      }
      IM.$("#uploadProgress").hidden = true;
      IM.$("#btnPickArchive").disabled = false;
      if (st.id) {
        try { await IM.invoke("transfer/uploadClose", { id: st.id }); } catch (_) {}
        st.id = null;
      }
      st.busy = false;
    }
  }

  async function chooseArchive() {
    const bridge = hostFileTransfer();
    if (bridge && typeof bridge.pick === "function") {
      try {
        const result = await bridge.pick({ multiple: false });
        const file = result && result.files && result.files[0];
        if (!file) return null;
        return {
          kind: "host", handleId: file.handleId,
          name: file.name || "image", size: Number(file.size) || 0,
        };
      } catch (_) {
        /* Host bridge present but this host cannot pick files (web host, older
           build): fall through to the browser input. */
      }
    }
    const input = IM.$("#uploadFileInput");
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        input.removeEventListener("change", onChange);
        window.removeEventListener("focus", onFocus);
        resolve(value);
      };
      const onChange = () => {
        const file = input.files && input.files[0];
        finish(file ? { kind: "browser", file, name: file.name, size: file.size } : null);
      };
      // There is no "cancel" event for a file input; focus returning to the
      // window is the portable signal that the dialog closed.
      const onFocus = () => setTimeout(() => finish(null), 300);
      input.addEventListener("change", onChange);
      window.addEventListener("focus", onFocus, { once: true });
      input.value = "";
      input.click();
    });
  }

  async function readArchiveChunk(picked, offset, length) {
    if (picked.kind === "host") {
      const bridge = hostFileTransfer();
      const part = await bridge.read(picked.handleId, offset, length);
      return {
        data: (part && part.dataBase64) || "",
        length: Number(part && part.length) || 0,
        eof: !!(part && part.eof),
      };
    }
    const buffer = await picked.file.slice(offset, offset + length).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return {
      data: bytesToBase64(bytes),
      length: bytes.length,
      eof: offset + bytes.length >= picked.file.size,
    };
  }

  async function uploadArchive(st, picked) {
    IM.$("#uploadFileName").textContent = picked.name + " · " + IM.fmtSize(picked.size);
    IM.$("#uploadProgress").hidden = false;
    setBar(IM.$("#uploadBar"), 0);
    setStatus(IM.$("#uploadStatusText"), fill(IM.t("upload.uploading"), { pct: 0 }));

    const begin = await IM.invoke("transfer/uploadBegin", { name: picked.name, size: picked.size });
    st.id = begin.id;
    const chunkBytes = Number(begin.chunkBytes) || CHUNK;
    let offset = 0;
    for (;;) {
      if (st.cancelled) throw new Error(IM.t("upload.cancelled"));
      const part = await readArchiveChunk(picked, offset, chunkBytes);
      if (!part.length) break;
      if (!part.data) throw new Error(IM.t("upload.failed"));
      await IM.invoke("transfer/uploadChunk", {
        id: st.id, offset, data: part.data,
      });
      offset += part.length;
      const pct = picked.size ? Math.min(99, progressPct(offset, picked.size)) : 50;
      setBar(IM.$("#uploadBar"), pct);
      setStatus(IM.$("#uploadStatusText"), fill(IM.t("upload.uploading"), { pct }));
      if (part.eof) break;
    }
    if (picked.kind === "host") {
      const bridge = hostFileTransfer();
      if (bridge && typeof bridge.cancel === "function") {
        try { await bridge.cancel(picked.handleId); } catch (_) {}
      }
    }
    await IM.invoke("transfer/uploadEnd", { id: st.id });
    setBar(IM.$("#uploadBar"), 100);
    setStatus(IM.$("#uploadStatusText"), IM.t("upload.parsing"));
    await waitForUploadParse(st);
  }

  async function waitForUploadParse(st) {
    for (;;) {
      if (st.cancelled) return;
      const status = await IM.invoke("transfer/uploadStatus", { id: st.id });
      if (status.state === "error") {
        throw new Error(status.error || IM.t("upload.parseFailed"));
      }
      if (status.state === "ready") {
        st.status = status;
        st.parsed = true;
        st.busy = false;
        IM.$("#uploadProgress").hidden = true;
        IM.renderUploadDetails(st);
        return;
      }
      await sleep(300);
    }
  }

  IM.renderUploadDetails = function renderUploadDetails(st) {
    const archive = (st.status && st.status.archive) || {};
    const images = archive.images || [];
    if (!images.length) {
      showWarning(IM.$("#uploadWarning"), IM.t("upload.parseFailed"));
      return;
    }
    IM.$("#uploadDetails").hidden = false;
    const imageSelect = IM.$("#uploadImage");
    imageSelect.innerHTML = "";
    images.forEach((image, index) => {
      const option = document.createElement("option");
      const src = splitSourceRef(image);
      const ref = ((image.refs || [])[0] || "").trim();
      const fallback = (image.suggestedRepository || "") +
        (image.suggestedTag ? ":" + image.suggestedTag : "");
      option.value = String(index);
      option.textContent = ref || fallback || (IM.t("upload.image") + " " + (index + 1));
      imageSelect.appendChild(option);
    });
    const multiple = images.length > 1;
    IM.$("#uploadImageField").hidden = !multiple;
    imageSelect.value = String(st.imageIndex || 0);

    // The target is the repository the user is already looking at; only the
    // version tag is editable.
    IM.$("#uploadTargetProjectField").hidden = !st.harbor;
    setFact("uploadTargetProject", st.harbor ? st.targetProject : "");
    setFact("uploadTargetRepo", st.targetShort || st.targetRepo);

    const renderImage = (resetTag) => {
      const image = images[Number(imageSelect.value) || 0] || images[0];
      const src = splitSourceRef(image);
      setFact("uploadSourceSite", src.site);
      setFact("uploadSourceProject", src.project);
      setFact("uploadSourceRepo", src.repo);
      setFact("uploadSourceVersion", src.tag);
      setFact("uploadSourceFormat", String(image.format || archive.format || "").toUpperCase());
      setFact("uploadSourceLayers", image.layers == null ? "" : String(image.layers));
      setFact("uploadSourceSize", IM.fmtSize(image.size || 0));

      const platforms = image.platforms || [];
      const archCell = IM.$("#uploadSourceArch");
      archCell.innerHTML = "";
      if (platforms.length > 1) {
        const select = document.createElement("select");
        select.id = "uploadArch";
        platforms.forEach((p) => {
          const option = document.createElement("option");
          option.value = platformText(p);
          option.textContent = platformText(p);
          select.appendChild(option);
        });
        // The backend can still publish the whole index; keep that as an
        // explicit ARCH choice rather than silently dropping it.
        const all = document.createElement("option");
        all.value = "";
        all.textContent = IM.t("upload.allArch");
        select.appendChild(all);
        const preferred = platforms.findIndex((p) => p.os === "linux" && p.architecture === "amd64");
        select.selectedIndex = preferred >= 0 ? preferred : 0;
        archCell.appendChild(select);
      } else {
        const label = platformText(platforms[0]);
        archCell.textContent = label;
        archCell.title = label === "—" ? "" : label;
      }
      if (resetTag) IM.$("#uploadTag").value = src.tag || "";
      IM.$("#btnUploadPush").disabled = false;
      updateUploadTargetRef(st);
    };
    imageSelect.onchange = () => {
      st.imageIndex = Number(imageSelect.value) || 0;
      renderImage(true);
    };
    IM.$("#uploadTag").oninput = () => updateUploadTargetRef(st);
    renderImage(true);
  }

  IM.pushArchive = async function pushArchive() {
    const st = IM.transferState.upload;
    if (!st || !st.parsed || st.busy) return;
    const repo = st.targetRepo;
    const tag = IM.$("#uploadTag").value.trim();
    const arch = IM.$("#uploadArch");
    const platform = arch ? arch.value : "";
    if (!repo || !TAG_RE.test(tag)) { IM.toast(IM.t("upload.needTarget"), "err"); return; }
    if (!REPO_RE.test(repo)) { IM.toast(IM.t("upload.invalidRepo"), "err"); return; }

    st.busy = true;
    IM.$("#btnUploadPush").disabled = true;
    IM.$("#btnPickArchive").disabled = true;
    showWarning(IM.$("#uploadWarning"), "");
    IM.$("#uploadProgress").hidden = false;
    setBar(IM.$("#uploadBar"), 0);
    setStatus(IM.$("#uploadStatusText"), IM.t("upload.busy"));
    try {
      await IM.invoke("transfer/uploadPush", {
        id: st.id, imageIndex: st.imageIndex, repository: repo, tag, platform,
      });
      for (;;) {
        const status = await IM.invoke("transfer/uploadStatus", { id: st.id });
        const push = status.push || {};
        if (push.state === "error") throw new Error(push.error || IM.t("upload.failed"));
        if (push.total) {
          setBar(IM.$("#uploadBar"), progressPct(push.done || 0, push.total));
          setStatus(IM.$("#uploadStatusText"), fill(IM.t("upload.pushing"), {
            done: IM.fmtSize(push.done || 0), total: IM.fmtSize(push.total),
          }));
        } else {
          setStatus(IM.$("#uploadStatusText"), fill(IM.t("upload.pushPhase"), {
            phase: push.phase ? phaseLabel(push.phase) : IM.t("upload.busy"),
          }));
        }
        if (push.state === "done") break;
        await sleep(300);
      }
      setBar(IM.$("#uploadBar"), 100);
      await IM.closeUpload(true);
      IM.invalidate();
      IM.archCache.clear();
      IM.archInflight.clear();
      IM.refreshTree();
      IM.reloadContent(true);
      IM.toast(IM.t("upload.done") + ": " + repo + ":" + tag, "ok");
    } catch (e) {
      if (!st.cancelled) {
        showWarning(IM.$("#uploadWarning"), e.message || IM.t("upload.failed"));
        IM.toast(e.message || IM.t("upload.failed"), "err");
        IM.$("#btnUploadPush").disabled = false;
        IM.$("#btnPickArchive").disabled = false;
      }
      st.busy = false;
    }
  }

  /* --------------------------------------------------------------------- */
  /* Download                                                              */
  /* --------------------------------------------------------------------- */

  IM.downloadBtn = function downloadBtn(repo, reference, tag) {
    const button = IM.iconBtn(IM.t("download"), "download", () => IM.openDownload(repo, reference, tag));
    button.dataset.action = "download";
    return button;
  }

  IM.openDownload = async function openDownload(repo, reference, tag) {
    if (IM.transferState.download) return;
    const st = {
      repo, reference, tag: tag || "", plan: null, id: null,
      cancelled: false, busy: false,
    };
    IM.transferState.download = st;
    IM.resetDownloadForm(repo, reference);
    IM.$("#downloadModal").hidden = false;
    try {
      const plan = await IM.invoke("transfer/exportPlan", { repository: repo, reference });
      if (st.cancelled) return;
      st.plan = plan;
      IM.renderDownloadPlan(st);
    } catch (e) {
      if (st.cancelled) return;
      showWarning(IM.$("#downloadWarning"), e.message || IM.t("download.failed"));
      IM.$("#downloadConfig").hidden = true;
      IM.$("#downloadProgress").hidden = true;
    }
  }

  IM.resetDownloadForm = function resetDownloadForm(repo, reference) {
    IM.$("#downloadSource").textContent = repo + ":" + reference;
    IM.$("#downloadConfig").hidden = true;
    IM.$("#downloadProgress").hidden = false;
    IM.$("#downloadWarning").hidden = true;
    IM.$("#downloadWarning").textContent = "";
    IM.$("#btnDownloadStart").disabled = true;
    IM.$("#downloadPlatform").innerHTML = "";
    setBar(IM.$("#downloadBar"), 0);
    setStatus(IM.$("#downloadStatusText"), IM.t("download.loading"));
  }

  IM.closeDownload = async function closeDownload(silent) {
    const st = IM.transferState.download;
    if (!st) return;
    const wasBusy = st.busy;
    st.cancelled = true;
    const id = st.id;
    st.id = null;
    IM.transferState.download = null;
    IM.$("#downloadModal").hidden = true;
    if (!silent) {
      IM.$("#downloadProgress").hidden = true;
      IM.$("#downloadConfig").hidden = true;
      setStatus(IM.$("#downloadStatusText"), "");
      if (wasBusy) IM.toast(IM.t("download.cancelled"), "warn");
    }
    if (id) {
      try { await IM.invoke("transfer/exportClose", { id }); } catch (_) {}
    }
  }

  IM.renderDownloadPlan = function renderDownloadPlan(st) {
    const plan = st.plan || {};
    const platforms = plan.platforms || [];
    IM.$("#downloadConfig").hidden = false;
    IM.$("#downloadProgress").hidden = true;
    IM.$("#btnDownloadStart").disabled = false;
    const dockerOption = IM.$("#downloadFormat").querySelector('option[value="docker"]');
    dockerOption.disabled = plan.isImage === false;
    IM.$("#downloadFormat").value = plan.isImage === false ? "oci" : "docker";
    IM.$("#downloadCompression").value = "tar";
    IM.$("#downloadSize").textContent = fill(IM.t("download.size"), {
      size: IM.fmtSize(plan.size || 0),
    });
    IM.rebuildDownloadPlatforms(st, IM.$("#downloadFormat").value);
    IM.$("#downloadFormat").onchange = () => {
      IM.rebuildDownloadPlatforms(st, IM.$("#downloadFormat").value);
    };
    IM.$("#downloadPlatformField").hidden = !plan.isIndex && platforms.length <= 1;
    // Apply this after rebuildDownloadPlatforms: that function clears a stale
    // "no platform" warning, and running it last would also clear this one.
    if (plan.isImage === false) {
      showWarning(IM.$("#downloadWarning"), IM.t("download.notImage"));
    } else {
      const bridge = hostFileTransfer();
      const canChunk = !!(bridge && typeof bridge.beginSave === "function");
      const canSave = !!(window.dbxPlugin && typeof window.dbxPlugin.saveFile === "function");
      if (!canChunk && !canSave) showWarning(IM.$("#downloadWarning"), IM.t("download.browserHint"));
    }
    IM.$("#downloadFormatHint").textContent =
      IM.$("#downloadFormat").value === "docker" ? IM.t("download.dockerHint") : IM.t("download.ociHint");
  }

  IM.rebuildDownloadPlatforms = function rebuildDownloadPlatforms(st, format) {
    const select = IM.$("#downloadPlatform");
    const plan = st.plan || {};
    const platforms = plan.platforms || [];
    const previous = select.value;
    select.innerHTML = "";
    if (format === "oci" && plan.isIndex && platforms.length > 1) {
      const all = document.createElement("option");
      all.value = "";
      all.textContent = IM.t("download.allPlatforms");
      select.appendChild(all);
    }
    platforms.forEach((platform) => {
      const label = platform.os && platform.architecture
        ? platform.os + "/" + platform.architecture + (platform.variant ? "/" + platform.variant : "")
        : (platform.digest ? IM.shortDigest(platform.digest) : IM.t("download.platform"));
      const option = document.createElement("option");
      option.value = label;
      option.textContent = platform.size ? label + " · " + IM.fmtSize(platform.size) : label;
      select.appendChild(option);
    });
    if (format === "oci" && plan.isIndex && platforms.length > 1) {
      select.value = "";
    } else if (previous && Array.from(select.options).some((o) => o.value === previous)) {
      select.value = previous;
    } else {
      const preferred = platforms.findIndex((p) => p.os === "linux" && p.architecture === "amd64");
      select.selectedIndex = preferred >= 0 ? preferred : 0;
    }
    if (!platforms.length) {
      showWarning(IM.$("#downloadWarning"), IM.t("download.noPlatform"));
    } else if (IM.$("#downloadWarning").textContent === IM.t("download.noPlatform")) {
      showWarning(IM.$("#downloadWarning"), "");
    }
    IM.$("#downloadFormatHint").textContent =
      format === "docker" ? IM.t("download.dockerHint") : IM.t("download.ociHint");
    IM.$("#downloadPlatformField").hidden = !plan.isIndex && platforms.length <= 1;
  }

  IM.startDownload = async function startDownload() {
    const st = IM.transferState.download;
    if (!st || !st.plan || st.busy) return;
    const format = IM.$("#downloadFormat").value;
    const platform = IM.$("#downloadPlatform").value;
    const gzip = IM.$("#downloadCompression").value === "targz";
    if (format === "docker" && st.plan.isIndex && !platform) {
      IM.toast(IM.t("download.needPlatform"), "err");
      return;
    }
    const tag = st.plan.tag || st.tag || st.reference;
    st.busy = true;
    IM.$("#btnDownloadStart").disabled = true;
    IM.$("#downloadProgress").hidden = false;
    setBar(IM.$("#downloadBar"), 0);
    setStatus(IM.$("#downloadStatusText"), IM.t("download.preparing"));
    showWarning(IM.$("#downloadWarning"), "");
    try {
      const begin = await IM.invoke("transfer/exportBegin", {
        repository: st.repo, reference: st.reference,
        format, gzip, platform, tag,
      });
      st.id = begin.id;
      const status = await waitForExport(st);
      if (status.state === "error") throw new Error(status.error || IM.t("download.failed"));
      const saved = await saveExportArchive(st, status);
      if (!saved) {
        st.cancelled = true;
        IM.closeDownload(true);
        return;
      }
      await IM.invoke("transfer/exportClose", { id: st.id });
      st.id = null;
      IM.toast(IM.t("download.done"), "ok");
      IM.closeDownload(true);
    } catch (e) {
      if (!st.cancelled) {
        showWarning(IM.$("#downloadWarning"), e.message || IM.t("download.failed"));
        IM.toast(e.message || IM.t("download.failed"), "err");
      }
      if (st.id) {
        try { await IM.invoke("transfer/exportClose", { id: st.id }); } catch (_) {}
        st.id = null;
      }
      st.busy = false;
      IM.$("#btnDownloadStart").disabled = false;
    }
  }

  async function waitForExport(st) {
    for (;;) {
      if (st.cancelled) throw new Error(IM.t("download.cancelled"));
      const status = await IM.invoke("transfer/exportStatus", { id: st.id });
      if (status.state === "error" || status.state === "ready") return status;
      if (status.total) {
        setBar(IM.$("#downloadBar"), progressPct(status.done || 0, status.total));
        setStatus(IM.$("#downloadStatusText"), fill(IM.t("download.exporting"), {
          done: IM.fmtSize(status.done || 0), total: IM.fmtSize(status.total),
        }));
      } else {
        setStatus(IM.$("#downloadStatusText"), IM.t("download.preparing"));
      }
      await sleep(300);
    }
  }

  async function saveExportArchive(st, status) {
    const size = Number(status.size) || 0;
    const bridge = hostFileTransfer();
    if (bridge && typeof bridge.beginSave === "function") {
      let target = null;
      try {
        target = await bridge.beginSave({
          name: status.name || (status.tag ? "image-" + status.tag + ".tar" : "image.tar"),
          contentType: status.gzip ? "application/gzip" : "application/x-tar",
          size,
        });
      } catch (_) {
        // The namespace exists but this host cannot open a native save dialog
        // (an older desktop build or a web host). Fall back to the in-memory
        // path below instead of failing the download outright.
        target = false;
      }
      if (target === null) {
        await IM.invoke("transfer/exportClose", { id: st.id });
        st.id = null;
        return false;
      }
      if (target) {
        try {
          await streamIntoHostFile(st, status, target, size);
          if (st.cancelled) {
            if (typeof bridge.cancel === "function") {
              try { await bridge.cancel(target.handleId); } catch (_) {}
            }
            return false;
          }
          await bridge.finish(target.handleId);
        } catch (e) {
          if (typeof bridge.cancel === "function") {
            try { await bridge.cancel(target.handleId); } catch (_) {}
          }
          throw e;
        }
        return true;
      }
    }

    const chunks = [];
    let totalRead = 0;
    for (;;) {
      if (st.cancelled) throw new Error(IM.t("download.cancelled"));
      const part = await IM.invoke("transfer/exportChunk", {
        id: st.id, offset: totalRead, length: CHUNK,
      });
      if (part.length) chunks.push(base64ToBytes(part.data));
      totalRead += Number(part.length) || 0;
      if (size) {
        setBar(IM.$("#downloadBar"), progressPct(totalRead, size));
        setStatus(IM.$("#downloadStatusText"), fill(IM.t("download.saving"), {
          pct: progressPct(totalRead, size),
        }));
      }
      if (part.eof) break;
    }
    if (size > 256 * 1024 * 1024) {
      showWarning(IM.$("#downloadWarning"), IM.t("download.largeWarning"));
    }
    const blob = new Blob(chunks, { type: status.gzip ? "application/gzip" : "application/x-tar" });
    if (window.dbxPlugin && typeof window.dbxPlugin.saveFile === "function" && blob.size <= 256 * 1024 * 1024) {
      const saved = await window.dbxPlugin.saveFile({
        fileName: status.name, contentType: blob.type,
      }, new Uint8Array(await blob.arrayBuffer()));
      if (saved === null) {
        return false;
      }
      return true;
    }
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = status.name || "image.tar";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return true;
  }

  async function streamIntoHostFile(st, status, target, size) {
    let offset = 0;
    for (;;) {
      if (st.cancelled) throw new Error(IM.t("download.cancelled"));
      const part = await IM.invoke("transfer/exportChunk", {
        id: st.id, offset, length: CHUNK,
      });
      if (part.length) {
        // The bridge's JSON request limit is 2 MiB; a 4 MiB base64 chunk is
        // ~5.6 MiB and is rejected before it reaches the host. The binary
        // channel has an 8 MiB cap and no JSON encoding, so decode the chunk
        // and hand the host a Uint8Array.
        const bytes = base64ToBytes(part.data);
        const written = await hostFileTransfer().write(target.handleId, offset, bytes);
        offset = written && typeof written.nextOffset === "number"
          ? written.nextOffset : offset + bytes.length;
      }
      if (size) {
        setBar(IM.$("#downloadBar"), progressPct(offset, size));
        setStatus(IM.$("#downloadStatusText"), fill(IM.t("download.saving"), {
          pct: progressPct(offset, size),
        }));
      }
      if (part.eof) break;
    }
  }
})(window.IMREPO = window.IMREPO || {});
