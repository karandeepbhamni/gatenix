/* Gatenix Console SPA */
(function () {
  "use strict";
  const $ = sel => document.querySelector(sel);
  const content = $("#content");
  let ME = null;

  /* ============================ Boot ============================ */
  async function boot() {
    try {
      const data = await nx.api("/api/auth/me");
      ME = data.user;
    } catch (e) {
      location.href = "/sign-in?redirect=" + encodeURIComponent(location.pathname);
      return;
    }
    $("#logo").insertAdjacentHTML("afterbegin", nx.logoSVG);
    $("#username").textContent = ME.username;
    $("#avatar").textContent = ME.username.slice(0, 1).toUpperCase();
    if (ME.role !== "admin") document.querySelectorAll("[data-admin]").forEach(el => el.style.display = "none");
    document.querySelectorAll(".side-link[data-view]").forEach(b =>
      b.addEventListener("click", () => setView(b.dataset.view))
    );
    $("#signoutBtn").addEventListener("click", async () => {
      await nx.api("/api/auth/signout", { method: "POST" }).catch(() => {});
      location.href = "/";
    });
    $("#hamburger").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    setView("overview");
  }

  const TITLES = { overview: "Overview", tokens: "API Tokens", logs: "Request Logs", channels: "Channels", models: "Models", users: "Users", settings: "Settings", profile: "Profile" };
  function setView(v) {
    document.querySelectorAll(".side-link[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $("#viewTitle").textContent = TITLES[v] || v;
    $("#sidebar").classList.remove("open");
    ({ overview: viewOverview, tokens: viewTokens, logs: viewLogs, channels: viewChannels, models: viewModels, users: viewUsers, settings: viewSettings, profile: viewProfile }[v] || viewOverview)();
  }

  /* ============================ Modal ============================ */
  function openModal(html) { $("#modal").innerHTML = html; $("#modalBackdrop").classList.add("open"); }
  function closeModal() { $("#modalBackdrop").classList.remove("open"); }
  $("#modalBackdrop").addEventListener("click", e => { if (e.target === $("#modalBackdrop")) closeModal(); });

  const quotaPct = (used, quota) => (quota <= 0 ? 0 : Math.min(100, (used / quota) * 100));
  const quotaBar = (used, quota) => `
    <div style="background:var(--muted-hover);border-radius:99px;height:8px;overflow:hidden;margin-top:0.5rem">
      <div style="width:${quotaPct(used, quota).toFixed(1)}%;height:100%;background:linear-gradient(to right,#60a5fa,#a855f7)"></div>
    </div>`;

  /* ============================ Overview ============================ */
  async function viewOverview() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const s = await nx.api("/api/stats");
    const days = s.days || [];
    const maxC = Math.max(1, ...days.map(d => d.c));
    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="v">${nx.fmtNum(s.totalRequests)}</div><div class="l">Total requests</div></div>
        <div class="stat-card"><div class="v">${nx.fmtNum(s.promptTokens + s.completionTokens)}</div><div class="l">Tokens processed</div></div>
        <div class="stat-card"><div class="v">${nx.fmtMoney(s.totalCost)}</div><div class="l">Total cost</div></div>
        <div class="stat-card"><div class="v">${nx.fmtNum(s.tokenCount)}</div><div class="l">API tokens</div></div>
      </div>
      <div class="card mb-3">
        <div class="card-title">Quota usage</div>
        <div class="row spread"><span class="small dim">Used ${nx.fmtNum(s.used)} / ${s.quota < 0 ? "∞" : nx.fmtNum(s.quota)} credits</span><span class="small dim">1 credit = $0.000001</span></div>
        ${quotaBar(s.used, s.quota)}
      </div>
      <div class="card mb-3">
        <div class="card-title">Requests — last 14 days</div>
        ${days.length ? `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;padding-top:0.5rem">
          ${days.map(d => `<div title="${d.d}: ${d.c} requests" style="flex:1;background:linear-gradient(to top,#54708c,#a78bfa);border-radius:6px 6px 2px 2px;height:${Math.max(4, (d.c / maxC) * 100)}%;min-width:12px"></div>`).join("")}
        </div>
        <div class="row spread small dim mt-1"><span>${days[0].d}</span><span>${days[days.length - 1].d}</span></div>` : '<div class="empty">No requests yet. Use your API key to make the first call!</div>'}
      </div>
      <div class="card mb-3">
        <div class="card-title">Quick start</div>
        <p class="small dim mb-2">Create an API key in <b>Tokens</b>, then call the gateway:</p>
        <div class="codebox">curl ${location.origin}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "mock-chat", "messages": [{"role": "user", "content": "Hello!"}]}'</div>
        <p class="hint mt-2">mock-chat works instantly without any upstream key. Add real channels (free providers included) in Channels.</p>
      </div>
      <div class="card">
        <div class="card-title">Recent requests</div>
        ${s.recent.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Status</th><th>Latency</th></tr></thead><tbody>
          ${s.recent.map(r => `<tr><td class="small">${nx.fmtDate(r.created_at)}</td><td class="mono">${nx.esc(r.model)}</td><td>${nx.fmtNum(r.prompt_tokens + r.completion_tokens)}</td><td>${nx.fmtMoney(r.cost)}</td><td>${r.status_code < 400 ? '<span class="chip badge-ok">' + r.status_code + '</span>' : '<span class="chip badge-err">' + r.status_code + '</span>'}</td><td>${r.latency_ms} ms</td></tr>`).join("")}
        </tbody></table></div>` : '<div class="empty">No requests yet.</div>'}
      </div>`;
  }

  /* ============================ Tokens ============================ */
  async function viewTokens() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const data = await nx.api("/api/tokens");
    renderTokens(data.tokens);
  }
  function renderTokens(tokens) {
    content.innerHTML = `
      <div class="row spread mb-3">
        <p class="small dim">API keys authenticate requests to <span class="mono">/v1/*</span> endpoints.</p>
        <button class="btn btn-primary btn-sm" id="newTokenBtn">+ New token</button>
      </div>
      ${tokens.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Key</th><th>Quota</th><th>Used</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody>
        ${tokens.map(t => `<tr>
          <td><b>${nx.esc(t.name)}</b>${t.username ? `<div class="small dim">${nx.esc(t.username)}</div>` : ""}</td>
          <td class="mono">${nx.esc(t.token_key.slice(0, 10))}…${nx.esc(t.token_key.slice(-4))} <button class="btn btn-ghost btn-sm" data-copy="${nx.esc(t.token_key)}">Copy</button></td>
          <td>${t.quota < 0 ? "∞" : nx.fmtNum(t.quota)}</td>
          <td>${nx.fmtNum(t.used)}</td>
          <td>${t.status === 1 ? '<span class="chip badge-ok">enabled</span>' : '<span class="chip badge-err">disabled</span>'}</td>
          <td class="small">${t.last_used_at ? nx.fmtDate(t.last_used_at) : "never"}</td>
          <td class="right">
            <button class="btn btn-ghost btn-sm" data-toggle="${t.id}" data-status="${t.status}">${t.status === 1 ? "Disable" : "Enable"}</button>
            <button class="btn btn-danger btn-sm" data-del="${t.id}">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody></table></div>` : '<div class="empty">No API tokens yet. Create one to start using the API.</div>'}`;
    $("#newTokenBtn").addEventListener("click", () => { openModal(`
      <h3>Create API token</h3>
      <div class="field"><label>Name</label><input class="input" id="tkName" placeholder="e.g. my-app-key" /></div>
      <div class="field"><label>Quota (credits, -1 = unlimited)</label><input class="input" id="tkQuota" type="number" value="-1" /></div>
      <div class="modal-actions"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('modalBackdrop').classList.remove('open')">Cancel</button><button class="btn btn-primary btn-sm" id="tkCreate">Create</button></div>`);
      $("#tkCreate").addEventListener("click", async () => {
        try {
          const res = await nx.api("/api/tokens", { method: "POST", body: { name: $("#tkName").value.trim(), quota: Number($("#tkQuota").value) } });
          openModal(`
            <h3>Token created</h3>
            <p class="small dim mb-2">Copy this key now — it is shown only once.</p>
            <div class="codebox">${nx.esc(res.key)}</div>
            <div class="modal-actions"><button class="btn btn-secondary btn-sm" id="tkCopyBtn">Copy key</button><button class="btn btn-primary btn-sm" onclick="document.getElementById('modalBackdrop').classList.remove('open')">Done</button></div>`);
          $("#tkCopyBtn").addEventListener("click", () => nx.copy(res.key));
          viewTokens();
        } catch (e) { nx.toast(e.message, false); }
      });
    });
    content.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => nx.copy(b.dataset.copy)));
    content.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
      await nx.api("/api/tokens/" + b.dataset.toggle, { method: "PATCH", body: { status: b.dataset.status === "1" ? 0 : 1 } });
      nx.toast("Token updated"); viewTokens();
    }));
    content.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this token? Requests using it will stop working.")) return;
      await nx.api("/api/tokens/" + b.dataset.del, { method: "DELETE" });
      nx.toast("Token deleted"); viewTokens();
    }));
  }

  /* ============================ Logs ============================ */
  let logOffset = 0;
  async function viewLogs() {
    logOffset = 0;
    await loadLogs();
  }
  async function loadLogs() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const data = await nx.api(`/api/logs?limit=50&offset=${logOffset}`);
    const logs = data.logs;
    content.innerHTML = `
      <div class="row spread mb-3"><p class="small dim">${nx.fmtNum(data.total)} total requests</p><button class="btn btn-secondary btn-sm" id="refreshLogs">Refresh</button></div>
      ${logs.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th>${ME.role === "admin" ? "<th>User</th>" : ""}<th>Model</th><th>Endpoint</th><th>Tokens</th><th>Cost</th><th>Status</th><th>Latency</th></tr></thead><tbody>
        ${logs.map(l => `<tr>
          <td class="small">${nx.fmtDate(l.created_at)}</td>
          ${ME.role === "admin" ? `<td>${nx.esc(l.username || "-")}</td>` : ""}
          <td class="mono">${nx.esc(l.model)}</td>
          <td><span class="chip">${nx.esc(l.endpoint)}</span></td>
          <td>${nx.fmtNum(l.prompt_tokens + l.completion_tokens)}</td>
          <td>${nx.fmtMoney(l.cost)}</td>
          <td>${l.status_code < 400 ? '<span class="chip badge-ok">' + l.status_code + '</span>' : `<span class="chip badge-err" title="${nx.esc(l.error || "")}">${l.status_code}</span>`}</td>
          <td>${l.latency_ms} ms</td>
        </tr>`).join("")}
      </tbody></table></div>
      <div class="row mt-2" style="justify-content:center;gap:1rem">
        <button class="btn btn-secondary btn-sm" id="prevPage" ${logOffset === 0 ? "disabled" : ""}>← Prev</button>
        <span class="small dim">${logOffset + 1}–${Math.min(logOffset + 50, data.total)} of ${data.total}</span>
        <button class="btn btn-secondary btn-sm" id="nextPage" ${logOffset + 50 >= data.total ? "disabled" : ""}>Next →</button>
      </div>` : '<div class="empty">No requests logged yet.</div>'}`;
    $("#refreshLogs").addEventListener("click", loadLogs);
    const prev = $("#prevPage"), next = $("#nextPage");
    if (prev) prev.addEventListener("click", () => { logOffset = Math.max(0, logOffset - 50); loadLogs(); });
    if (next) next.addEventListener("click", () => { logOffset += 50; loadLogs(); });
  }

  /* ============================ Channels ============================ */
  async function viewChannels() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const [data, tpl] = await Promise.all([nx.api("/api/channels"), nx.api("/api/channels/templates")]);
    renderChannels(data.channels, tpl.templates);
  }
  function renderChannels(channels, templates) {
    content.innerHTML = `
      <div class="row spread mb-3">
        <p class="small dim">Channels are upstream AI providers. Requests route to the highest-priority channel that supports the model (with automatic fallback).</p>
        <button class="btn btn-primary btn-sm" id="addChannelBtn">+ Add channel</button>
      </div>
      ${channels.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Type</th><th>Base URL</th><th>Key</th><th>Models</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>
        ${channels.map(c => `<tr>
          <td><b>${nx.esc(c.name)}</b></td>
          <td><span class="chip">${nx.esc(c.type)}</span></td>
          <td class="mono small">${nx.esc(c.base_url || "—")}</td>
          <td class="mono small">${nx.esc(c.api_key_masked || "—")}</td>
          <td class="small">${c.models.includes("*") ? '<span class="chip">all models</span>' : c.models.length + " models"}</td>
          <td>${c.priority}</td>
          <td>${c.status === 1 ? '<span class="chip badge-ok">enabled</span>' : '<span class="chip badge-err">disabled</span>'}</td>
          <td class="right">
            <button class="btn btn-ghost btn-sm" data-test="${c.id}">Test</button>
            <button class="btn btn-ghost btn-sm" data-toggle="${c.id}" data-status="${c.status}">${c.status === 1 ? "Disable" : "Enable"}</button>
            <button class="btn btn-danger btn-sm" data-del="${c.id}">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody></table></div>` : '<div class="empty">No channels configured.</div>'}`;

    $("#addChannelBtn").addEventListener("click", () => {
      openModal(`
        <h3>Add channel</h3>
        <div class="field"><label>Template</label>
          <select class="select" id="chTpl">
            ${templates.map(t => `<option value="${t.id}">${nx.esc(t.name)}</option>`).join("")}
          </select>
          <div class="hint" id="chTplHint"></div>
        </div>
        <div class="field"><label>Channel name</label><input class="input" id="chName" /></div>
        <div class="field"><label>Base URL</label><input class="input" id="chBase" placeholder="https://…" /></div>
        <div class="field" id="chKeyField"><label>API key</label><input class="input" id="chKey" placeholder="Paste your API key" /></div>
        <div class="field"><label>Models (comma-separated, or * for all)</label><input class="input" id="chModels" value="*" /></div>
        <div class="field"><label>Priority (higher = preferred)</label><input class="input" id="chPriority" type="number" value="0" /></div>
        <div class="modal-actions"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('modalBackdrop').classList.remove('open')">Cancel</button><button class="btn btn-primary btn-sm" id="chCreate">Add channel</button></div>`);
      const sel = $("#chTpl");
      const applyTpl = () => {
        const t = templates.find(x => x.id === sel.value);
        if (!t) return;
        $("#chName").value = t.name;
        $("#chBase").value = t.base_url;
        $("#chTplHint").textContent = t.hint;
        $("#chKeyField").style.display = t.needsKey ? "" : "none";
        $("#chCreate").dataset.type = t.type;
      };
      sel.addEventListener("change", applyTpl);
      applyTpl();
      $("#chCreate").addEventListener("click", async () => {
        try {
          const models = $("#chModels").value.split(",").map(s => s.trim()).filter(Boolean);
          await nx.api("/api/channels", { method: "POST", body: {
            name: $("#chName").value.trim(), type: $("#chCreate").dataset.type,
            base_url: $("#chBase").value.trim(), api_key: $("#chKey") ? $("#chKey").value.trim() : "",
            models: models.length ? models : ["*"], priority: Number($("#chPriority").value) || 0,
          }});
          closeModal(); nx.toast("Channel added"); viewChannels();
        } catch (e) { nx.toast(e.message, false); }
      });
    });

    content.querySelectorAll("[data-test]").forEach(b => b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "Testing…";
      const chName = b.closest("tr")?.querySelector("b")?.textContent || ("#" + b.dataset.test);
      try {
        const r = await nx.api(`/api/channels/${b.dataset.test}/test`, { method: "POST", body: {} });
        r.ok ? nx.toast(`${chName}: OK (${r.latency_ms} ms)`) : nx.toast(`${chName}: test failed on "${r.model || "?"}" — ${r.error}`, false);
      } catch (e) { nx.toast(`${chName}: ${e.message}`, false); }
      b.disabled = false; b.textContent = "Test";
    }));
    content.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
      await nx.api("/api/channels/" + b.dataset.toggle, { method: "PATCH", body: { status: b.dataset.status === "1" ? 0 : 1 } });
      viewChannels();
    }));
    content.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this channel?")) return;
      await nx.api("/api/channels/" + b.dataset.del, { method: "DELETE" });
      nx.toast("Channel deleted"); viewChannels();
    }));
  }

  /* ============================ Models ============================ */
  async function viewModels() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const data = await nx.api("/api/models/all");
    renderModels(data.models);
  }
  function renderModels(models) {
    content.innerHTML = `
      <div class="row spread mb-3">
        <p class="small dim">Models listed here appear in Model Square and are routable through the gateway.</p>
        <button class="btn btn-primary btn-sm" id="addModelBtn">+ Add model</button>
      </div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Model ID</th><th>Vendor</th><th>Pricing</th><th>Group</th><th>Status</th><th></th></tr></thead><tbody>
        ${models.map(m => `<tr>
          <td class="mono">${nx.esc(m.model_id)}<div class="small dim">${nx.esc(m.display_name || "")}</div></td>
          <td>${nx.esc(m.vendor)}</td>
          <td class="small">${m.pricing_type === "free" ? '<span class="chip badge-free">FREE</span>' : m.pricing_type === "per_request" ? `$${m.price_request}/req` : `$${m.price_input}/$${m.price_output} per 1M`}</td>
          <td><span class="chip">${nx.esc(m.group_name)}</span></td>
          <td>${m.status === 1 ? '<span class="chip badge-ok">enabled</span>' : '<span class="chip badge-err">disabled</span>'}</td>
          <td class="right">
            <button class="btn btn-ghost btn-sm" data-toggle="${m.id}" data-status="${m.status}">${m.status === 1 ? "Disable" : "Enable"}</button>
            <button class="btn btn-danger btn-sm" data-del="${m.id}">Delete</button>
          </td>
        </tr>`).join("")}
      </tbody></table></div>`;
    $("#addModelBtn").addEventListener("click", () => { openModal(`
      <h3>Add model</h3>
      <div class="field"><label>Model ID</label><input class="input" id="mId" placeholder="e.g. vendor/model-name" /></div>
      <div class="field"><label>Display name</label><input class="input" id="mName" /></div>
      <div class="field"><label>Vendor</label><input class="input" id="mVendor" /></div>
      <div class="field"><label>Pricing type</label><select class="select" id="mPricing"><option value="free">free</option><option value="token">token (per 1M)</option><option value="per_request">per_request</option></select></div>
      <div class="field"><label>Price input / output / request ($)</label>
        <div class="row"><input class="input" id="mIn" type="number" step="0.01" value="0" /><input class="input" id="mOut" type="number" step="0.01" value="0" /><input class="input" id="mReq" type="number" step="0.01" value="0" /></div></div>
      <div class="field"><label>Context length</label><input class="input" id="mCtx" type="number" value="128000" /></div>
      <div class="modal-actions"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('modalBackdrop').classList.remove('open')">Cancel</button><button class="btn btn-primary btn-sm" id="mCreate">Add</button></div>`);
      $("#mCreate").addEventListener("click", async () => {
        try {
          await nx.api("/api/models", { method: "POST", body: {
            model_id: $("#mId").value.trim(), display_name: $("#mName").value.trim(), vendor: $("#mVendor").value.trim(),
            pricing_type: $("#mPricing").value, price_input: Number($("#mIn").value), price_output: Number($("#mOut").value),
            price_request: Number($("#mReq").value), context_length: Number($("#mCtx").value),
          }});
          closeModal(); nx.toast("Model added"); viewModels();
        } catch (e) { nx.toast(e.message, false); }
      });
    });
    content.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
      await nx.api("/api/models/" + b.dataset.toggle, { method: "PATCH", body: { status: b.dataset.status === "1" ? 0 : 1 } });
      viewModels();
    }));
    content.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this model?")) return;
      await nx.api("/api/models/" + b.dataset.del, { method: "DELETE" });
      viewModels();
    }));
  }

  /* ============================ Users ============================ */
  async function viewUsers() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const data = await nx.api("/api/users");
    content.innerHTML = `
      <div class="table-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Username</th><th>Email</th><th>Role</th><th>Quota</th><th>Used</th><th>Status</th><th></th></tr></thead><tbody>
        ${data.users.map(u => `<tr>
          <td>${u.id}</td>
          <td><b>${nx.esc(u.username)}</b></td>
          <td class="small">${nx.esc(u.email || "—")}</td>
          <td><span class="chip ${u.role === "admin" ? "badge-warn" : ""}">${nx.esc(u.role)}</span></td>
          <td>${nx.fmtNum(u.quota)}</td>
          <td>${nx.fmtNum(u.used)}</td>
          <td>${u.status === 1 ? '<span class="chip badge-ok">enabled</span>' : '<span class="chip badge-err">disabled</span>'}</td>
          <td class="right">
            <button class="btn btn-ghost btn-sm" data-quota="${u.id}">Set quota</button>
            <button class="btn btn-ghost btn-sm" data-ustat="${u.id}" data-status="${u.status}">${u.status === 1 ? "Disable" : "Enable"}</button>
          </td>
        </tr>`).join("")}
      </tbody></table></div>`;
    content.querySelectorAll("[data-quota]").forEach(b => b.addEventListener("click", async () => {
      const v = prompt("New quota (credits):", "1000000");
      if (v == null) return;
      await nx.api("/api/users/" + b.dataset.quota, { method: "PATCH", body: { quota: Number(v) } });
      nx.toast("Quota updated"); viewUsers();
    }));
    content.querySelectorAll("[data-ustat]").forEach(b => b.addEventListener("click", async () => {
      await nx.api("/api/users/" + b.dataset.ustat, { method: "PATCH", body: { status: b.dataset.status === "1" ? 0 : 1 } });
      viewUsers();
    }));
  }

  /* ============================ Settings ============================ */
  async function viewSettings() {
    content.innerHTML = '<div class="empty">Loading…</div>';
    const data = await nx.api("/api/settings");
    const s = data.settings;
    content.innerHTML = `
      <div class="card" style="max-width:560px">
        <div class="card-title">Site settings</div>
        <div class="field"><label>Site name</label><input class="input" id="sName" value="${nx.esc(s.site_name || "")}" /></div>
        <div class="field"><label>Description</label><input class="input" id="sDesc" value="${nx.esc(s.site_description || "")}" /></div>
        <div class="field"><label>Default quota for new users (credits)</label><input class="input" id="sQuota" type="number" value="${nx.esc(s.default_user_quota || "500000")}" /></div>
        <div class="field"><label>Server address (shown in docs)</label><input class="input" id="sAddr" value="${nx.esc(s.server_address || "")}" placeholder="https://api.yourdomain.com" /></div>
        <button class="btn btn-primary btn-sm" id="saveSettings">Save settings</button>
      </div>
      <div class="card mt-3" style="max-width:560px">
        <div class="card-title">Social login (OAuth)</div>
        <p class="small dim mb-2">Enable "Continue with GitHub / Google" on the sign-in page. Callback URLs to register:</p>
        <div class="codebox mb-2" style="font-size:0.72rem">${location.origin}/api/auth/github/callback<br>${location.origin}/api/auth/google/callback</div>
        <div class="field"><label>GitHub Client ID</label><input class="input mono" id="oGhId" value="${nx.esc(s.github_client_id || "")}" placeholder="e.g. Iv1.abc123…" /></div>
        <div class="field"><label>GitHub Client Secret</label><input class="input mono" id="oGhSecret" value="${nx.esc(s.github_client_secret || "")}" placeholder="generate one in your GitHub OAuth app" /></div>
        <div class="field"><label>Google Client ID</label><input class="input mono" id="oGgId" value="${nx.esc(s.google_client_id || "")}" placeholder="xxxx.apps.googleusercontent.com" /></div>
        <div class="field"><label>Google Client Secret</label><input class="input mono" id="oGgSecret" value="${nx.esc(s.google_client_secret || "")}" placeholder="GOCSPX-…" /></div>
        <button class="btn btn-primary btn-sm" id="saveOAuth">Save social login</button>
      </div>`;
    $("#saveSettings").addEventListener("click", async () => {
      await nx.api("/api/settings", { method: "PUT", body: {
        site_name: $("#sName").value, site_description: $("#sDesc").value,
        default_user_quota: $("#sQuota").value, server_address: $("#sAddr").value,
      }});
      nx.toast("Settings saved");
    });
    $("#saveOAuth").addEventListener("click", async () => {
      await nx.api("/api/settings", { method: "PUT", body: {
        github_client_id: $("#oGhId").value.trim(), github_client_secret: $("#oGhSecret").value.trim(),
        google_client_id: $("#oGgId").value.trim(), google_client_secret: $("#oGgSecret").value.trim(),
      }});
      nx.toast("Social login saved");
    });
  }

  /* ============================ Profile ============================ */
  function viewProfile() {
    content.innerHTML = `
      <div class="card mb-3" style="max-width:560px">
        <div class="card-title">Account</div>
        <p><b>${nx.esc(ME.username)}</b> <span class="chip">${nx.esc(ME.role)}</span></p>
        <p class="small dim mt-1">${nx.esc(ME.email || "No email set")} · joined ${nx.fmtDate(ME.created_at)}</p>
        <div class="mt-2"><span class="small dim">Quota: ${nx.fmtNum(ME.used)} / ${ME.quota < 0 ? "∞" : nx.fmtNum(ME.quota)} credits used</span>${quotaBar(ME.used, ME.quota)}</div>
      </div>
      <div class="card" style="max-width:560px">
        <div class="card-title">Change password</div>
        <div class="alert alert-error" id="pwAlert"></div>
        <div class="field"><label>Current password</label><input class="input" id="pwCur" type="password" /></div>
        <div class="field"><label>New password</label><input class="input" id="pwNew" type="password" /></div>
        <button class="btn btn-primary btn-sm" id="pwBtn">Update password</button>
      </div>`;
    $("#pwBtn").addEventListener("click", async () => {
      const alertEl = $("#pwAlert");
      alertEl.classList.remove("show");
      try {
        await nx.api("/api/profile/password", { method: "PUT", body: { current: $("#pwCur").value, next: $("#pwNew").value } });
        nx.toast("Password updated");
        $("#pwCur").value = ""; $("#pwNew").value = "";
      } catch (e) {
        alertEl.textContent = e.message; alertEl.classList.add("show");
      }
    });
  }

  boot();
})();
