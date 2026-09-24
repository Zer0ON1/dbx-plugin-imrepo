/* IMREPO workbench — DOM helpers.
 *
 * Classic script, not an ES module: the workbench is also opened over
 * file://, where module scripts are refused by CORS. Every file hangs its
 * exports on the shared `window.IMREPO` namespace (`IM` here) and reaches
 * the other modules through `IM.*`.
 */
(function (IM) {
  "use strict";

  IM.$ = function $(sel) { return document.querySelector(sel); }

  IM.el = function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) {
      if (typeof text === "string" || typeof text === "number") e.textContent = text;
      else if (text.nodeType) e.appendChild(text);
    }
    return e;
  }

  /* Inline SVG icons instead of text glyphs (◫ / 🛡 / ✕): those glyphs render as
   * thin monochrome outlines at 13px and read as "blurry" next to real text.
   * SVG inherits currentColor, so the icons stay crisp in both themes. */
  IM.ICONS = {
    layers: '<path d="M8 1.6 1.8 5 8 8.4 14.2 5 8 1.6Zm5.12 6.12L8 10.38 2.88 7.72 1.8 8.28 8 11.56l6.2-3.28-1.08-.56Zm0 3L8 13.38 2.88 10.72 1.8 11.28 8 14.56l6.2-3.28-1.08-.56Z"/>',
    shield: '<path d="M8 1 2.6 3.15v4.02c0 3.3 2.26 6.35 5.4 7.63 3.14-1.28 5.4-4.33 5.4-7.63V3.15L8 1Zm3.33 5.29-4.01 4.01-2.65-2.65 1.06-1.06 1.59 1.59 2.95-2.95 1.06 1.06Z"/>',
    close: '<path d="M4.28 3.22 8 6.94l3.72-3.72 1.06 1.06L9.06 8l3.72 3.72-1.06 1.06L8 9.06l-3.72 3.72-1.06-1.06L6.94 8 3.22 4.28l1.06-1.06Z"/>',
    folder: '<path d="M8 1.6 1.8 5 8 8.4 14.2 5 8 1.6Zm5.12 6.12L8 10.38 2.88 7.72 1.8 8.28 8 11.56l6.2-3.28-1.08-.56Zm0 3L8 13.38 2.88 10.72 1.8 11.28 8 14.56l6.2-3.28-1.08-.56Z"/>',
    repo: '<path d="M8 1.6 1.8 5 8 8.4 14.2 5 8 1.6Zm5.12 6.12L8 10.38 2.88 7.72 1.8 8.28 8 11.56l6.2-3.28-1.08-.56Zm0 3L8 13.38 2.88 10.72 1.8 11.28 8 14.56l6.2-3.28-1.08-.56Z"/>',
    tag: '<path d="M7.72 1.4H14v6.28l-6.32 6.32a1.4 1.4 0 0 1-1.98 0L1.4 9.7a1.4 1.4 0 0 1 0-1.98L7.72 1.4Zm3.06 2.02a1.28 1.28 0 1 0 0 2.56 1.28 1.28 0 0 0 0-2.56Z"/>',
    pull: '<path d="M7.25 1.5h1.5v6.44l2.22-2.22 1.06 1.06L8 10.81 3.97 6.78l1.06-1.06 2.22 2.22V1.5ZM2.5 12.5h11v1.5h-11v-1.5Z"/>',
    lock: '<path d="M8 1.2A3.3 3.3 0 0 0 4.7 4.5v1.6h-.5A1.2 1.2 0 0 0 3 7.3v6A1.2 1.2 0 0 0 4.2 14.5h7.6A1.2 1.2 0 0 0 13 13.3v-6a1.2 1.2 0 0 0-1.2-1.2h-.5V4.5A3.3 3.3 0 0 0 8 1.2Zm0 1.6a1.7 1.7 0 0 1 1.7 1.7v1.6H6.3V4.5A1.7 1.7 0 0 1 8 2.8Zm0 5.6a1.3 1.3 0 0 1 .7 2.4v1.5H7.3v-1.5A1.3 1.3 0 0 1 8 8.4Z"/>',
    scan: '<path d="M3 1.8h3.2v1.6H4.6v1.6H3V1.8Zm6.8 0H13v3.2h-1.6V3.4H9.8V1.8ZM4.6 11h1.6v1.6H4.6V11ZM3 9.4h1.6V11H3V9.4Zm9.4 0H13v3.2h-3.2V11h1.6V9.4ZM5.9 5.6h4.2v4.2H5.9V5.6Z"/>',
    gear: '<path d="M8 1a1.4 1.4 0 0 1 1.4 1.4l.1.6c.5.2.9.4 1.3.7l.6-.2a1.4 1.4 0 0 1 1.7.7l.6 1a1.4 1.4 0 0 1-.4 1.8l-.4.4c.1.4.1.8.1 1.2l-.1.4.4.4a1.4 1.4 0 0 1 .4 1.8l-.6 1a1.4 1.4 0 0 1-1.7.7l-.6-.2c-.4.3-.8.5-1.3.7l-.1.6A1.4 1.4 0 0 1 8 15a1.4 1.4 0 0 1-1.4-1.4l-.1-.6c-.5-.2-.9-.4-1.3-.7l-.6.2a1.4 1.4 0 0 1-1.7-.7l-.6-1a1.4 1.4 0 0 1 .4-1.8l.4-.4a5 5 0 0 1-.1-1.2l.1-.4-.4-.4a1.4 1.4 0 0 1-.4-1.8l.6-1a1.4 1.4 0 0 1 1.7-.7l.6.2c.4-.3.8-.5 1.3-.7l.1-.6A1.4 1.4 0 0 1 8 1Zm0 4.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6Z"/>',
  };

  IM.svgIcon = function svgIcon(name) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    s.innerHTML = IM.ICONS[name] || "";
    return s;
  }

  IM.loadingHTML = function loadingHTML() {
    return `<div class="loading"><span class="spinner"></span>${IM.t("loading")}</div>`;
  }

  IM.toast = function toast(msg, kind) {
    const el = IM.$("#toast");
    el.textContent = msg;
    el.className = "toast" + (kind ? " " + kind : "");
    el.hidden = false;
    clearTimeout(el._t);
    // Warnings and errors carry detail the user has to read (and often copy).
    el._t = setTimeout(() => (el.hidden = true), kind === "warn" || kind === "err" ? 7000 : 2600);
  }

  /** Copies text and resolves with whether it worked (callers may want feedback). */
  IM.copyText = function copyText(text, quiet) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => { if (!quiet) IM.toast(IM.t("copied"), "ok"); return true; })
        .catch(() => IM.fallbackCopy(text, quiet));
    }
    return Promise.resolve(IM.fallbackCopy(text, quiet));
  }

  IM.fallbackCopy = function fallbackCopy(text, quiet) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      if (!quiet) IM.toast(IM.t("copied"), "ok");
      return true;
    } catch (_) {
      IM.toast(IM.t("copyFailed"), "err");
      return false;
    }
  }

  IM.iconBtn = function iconBtn(title, icon, onClick, extraCls) {
    const b = IM.el("button", "icon-btn" + (extraCls ? " " + extraCls : ""));
    b.title = title;
    if (IM.ICONS[icon]) {
      b.setAttribute("aria-label", title);
      b.appendChild(IM.svgIcon(icon));
    } else {
      b.textContent = icon;
    }
    b.addEventListener("click", onClick);
    return b;
  }
})(window.IMREPO = window.IMREPO || {});
