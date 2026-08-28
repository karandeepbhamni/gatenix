/* Gatenix shared frontend utilities */
(function () {
  "use strict";

  /* ---------- Theme ---------- */
  function applyTheme(t) {
    const root = document.documentElement;
    root.classList.toggle("dark", t === "dark");
    root.classList.toggle("light", t === "light");
    try { localStorage.setItem("nx-theme", t); } catch (e) {}
    document.querySelectorAll("[data-theme-icon]").forEach(el => {
      el.style.display = el.dataset.themeIcon === t ? "" : "none";
    });
  }
  let saved = null;
  try { saved = localStorage.getItem("nx-theme"); } catch (e) {}
  applyTheme(saved === "light" ? "light" : "dark");

  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-theme-toggle]");
    if (btn) applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
  });

  /* ---------- API helper ---------- */
  window.nx = window.nx || {};
  nx.api = async function (path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      credentials: "same-origin",
      ...opts,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = (data && (data.error?.message || data.error)) || `Request failed (${res.status})`;
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      err.status = res.status;
      throw err;
    }
    return data;
  };

  /* ---------- Toast ---------- */
  nx.toast = function (msg, ok = true) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.borderColor = ok ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)";
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 3200);
  };

  /* ---------- Helpers ---------- */
  nx.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  nx.fmtMoney = v => "$" + Number(v || 0).toFixed(5);
  nx.fmtNum = v => Number(v || 0).toLocaleString();
  nx.fmtDate = s => {
    if (!s) return "—";
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    return d.toLocaleString();
  };
  nx.copy = async function (text) {
    try { await navigator.clipboard.writeText(text); nx.toast("Copied to clipboard"); }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); nx.toast("Copied to clipboard"); } catch (e2) { nx.toast("Copy failed", false); }
      ta.remove();
    }
  };
  nx.logoSVG = `
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs><linearGradient id="nxlg" x1="0" y1="0" x2="32" y2="32">
        <stop offset="0" stop-color="#60a5fa"/><stop offset="0.5" stop-color="#a78bfa"/><stop offset="1" stop-color="#a855f7"/>
      </linearGradient></defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#nxlg)" opacity="0.16"/>
      <rect x="2" y="2" width="28" height="28" rx="8" stroke="url(#nxlg)" stroke-width="1.5"/>
      <path d="M19.5 11.8A5.5 5.5 0 1 0 21.5 16H16.5" stroke="url(#nxlg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
})();
