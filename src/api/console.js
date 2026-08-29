"use strict";
/**
 * Console REST API — used by the dashboard frontend.
 * Session-authenticated (cookie). Admin-only routes marked.
 */
const express = require("express");
const { db, newApiKey, hashPassword, verifyPassword } = require("../db");
const { requireUser, requireAdmin } = require("../auth");
const { getProvider, OPENAI_COMPAT_TYPES } = require("../providers");

const router = express.Router();

const maskKey = k => (k ? k.slice(0, 6) + "…" + k.slice(-4) : "");
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

/* ============================ Dashboard stats ============================ */
router.get("/stats", requireUser, (req, res) => {
  const uid = req.user.id;
  const isAdmin = req.user.role === "admin";
  const scope = isAdmin ? "" : " WHERE user_id = " + uid;
  const totalRequests = db.prepare(`SELECT COUNT(*) c FROM logs${scope}`).get().c;
  const agg = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens),0) pt, COALESCE(SUM(completion_tokens),0) ct, COALESCE(SUM(cost),0) cost,
            COALESCE(SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END),0) ok FROM logs${scope}`
  ).get();
  const tokenCount = db.prepare(`SELECT COUNT(*) c FROM api_tokens${isAdmin ? "" : " WHERE user_id = " + uid}`).get().c;
  const days = db.prepare(
    `SELECT date(created_at) d, COUNT(*) c FROM logs${scope ? scope + " AND" : " WHERE"} created_at >= datetime('now','-13 days') GROUP BY d ORDER BY d`
  ).all();
  const recent = db.prepare(
    `SELECT id, model, endpoint, prompt_tokens, completion_tokens, cost, status_code, latency_ms, created_at
     FROM logs${scope} ORDER BY id DESC LIMIT 8`
  ).all();
  const topModels = db.prepare(
    `SELECT model, COUNT(*) c FROM logs${scope} GROUP BY model ORDER BY c DESC LIMIT 5`
  ).all();
  res.json({
    quota: req.user.quota, used: req.user.used,
    totalRequests, promptTokens: agg.pt, completionTokens: agg.ct,
    totalCost: agg.cost, successCount: agg.ok, tokenCount,
    days, recent, topModels,
  });
});

/* ============================ API tokens ============================ */
router.get("/tokens", requireUser, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT t.*, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC").all()
    : db.prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id DESC").all(req.user.id);
  res.json({ tokens: rows });
});

router.post("/tokens", requireUser, (req, res) => {
  const { name, quota } = req.body || {};
  if (!name) return res.status(400).json({ error: "Token name required" });
  const key = newApiKey();
  const info = db.prepare(
    "INSERT INTO api_tokens (user_id, name, token_key, quota) VALUES (?, ?, ?, ?)"
  ).run(req.user.id, String(name).slice(0, 64), key, quota == null ? -1 : Math.floor(Number(quota)));
  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(info.lastInsertRowid);
  res.json({ ok: true, token: row, key }); // key shown once in UI
});

router.patch("/tokens/:id", requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Token not found" });
  if (req.user.role !== "admin" && row.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
  const { status, name, quota } = req.body || {};
  if (status != null) db.prepare("UPDATE api_tokens SET status = ? WHERE id = ?").run(status ? 1 : 0, row.id);
  if (name != null) db.prepare("UPDATE api_tokens SET name = ? WHERE id = ?").run(String(name).slice(0, 64), row.id);
  if (quota != null) db.prepare("UPDATE api_tokens SET quota = ? WHERE id = ?").run(Math.floor(Number(quota)), row.id);
  res.json({ ok: true, token: db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(row.id) });
});

router.delete("/tokens/:id", requireUser, (req, res) => {
  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Token not found" });
  if (req.user.role !== "admin" && row.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
  db.prepare("DELETE FROM api_tokens WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

/* ============================ Logs ============================ */
router.get("/logs", requireUser, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const where = req.user.role === "admin" ? "" : " WHERE user_id = " + req.user.id;
  const rows = db.prepare(
    `SELECT l.*, u.username FROM logs l LEFT JOIN users u ON u.id = l.user_id${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM logs${where}`).get().c;
  res.json({ logs: rows, total });
});

/* ============================ Models (public list + admin CRUD) ============================ */
router.get("/models", (req, res) => {
  const rows = db.prepare("SELECT * FROM models WHERE status = 1 ORDER BY vendor, model_id").all();
  res.json({
    models: rows.map(m => ({
      ...m,
      endpoints: parseJson(m.endpoints, []),
      tags: parseJson(m.tags, []),
    })),
  });
});

router.get("/models/all", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM models ORDER BY vendor, model_id").all();
  res.json({ models: rows.map(m => ({ ...m, endpoints: parseJson(m.endpoints, []), tags: parseJson(m.tags, []) })) });
});

router.post("/models", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.model_id) return res.status(400).json({ error: "model_id required" });
  try {
    db.prepare(
      `INSERT INTO models (model_id, display_name, vendor, description, pricing_type, price_input, price_output, price_request, context_length, endpoints, group_name, tags, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      b.model_id, b.display_name || b.model_id, b.vendor || "", b.description || "",
      b.pricing_type || "token", Number(b.price_input) || 0, Number(b.price_output) || 0, Number(b.price_request) || 0,
      Number(b.context_length) || 128000, JSON.stringify(b.endpoints || ["openai"]),
      b.group_name || "default", JSON.stringify(b.tags || []), b.status == null ? 1 : (b.status ? 1 : 0)
    );
  } catch (e) {
    return res.status(409).json({ error: "Model already exists" });
  }
  res.json({ ok: true });
});

router.patch("/models/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM models WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Model not found" });
  const b = req.body || {};
  db.prepare("UPDATE models SET display_name=?, vendor=?, description=?, pricing_type=?, price_input=?, price_output=?, price_request=?, context_length=?, endpoints=?, group_name=?, tags=?, status=? WHERE id=?")
    .run(
      b.display_name ?? row.display_name, b.vendor ?? row.vendor, b.description ?? row.description,
      b.pricing_type ?? row.pricing_type, Number(b.price_input ?? row.price_input), Number(b.price_output ?? row.price_output),
      Number(b.price_request ?? row.price_request), Number(b.context_length ?? row.context_length),
      JSON.stringify(b.endpoints || parseJson(row.endpoints, [])), b.group_name ?? row.group_name,
      JSON.stringify(b.tags || parseJson(row.tags, [])), b.status == null ? row.status : (b.status ? 1 : 0), row.id
    );
  res.json({ ok: true });
});

router.delete("/models/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM models WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ============================ Channels (admin) ============================ */
const CHANNEL_TEMPLATES = [
  { id: "mock", name: "Mock Provider (Demo)", type: "mock", base_url: "", needsKey: false, hint: "Built-in demo provider. No key needed — works instantly." },
  { id: "tokenrouter", name: "TokenRouter", type: "tokenrouter", base_url: "https://api.tokenrouter.com/v1", needsKey: true, hint: "Free key at tokenrouter.com — includes the free model z-ai/glm-5.3-free." },
  { id: "openrouter", name: "OpenRouter", type: "openrouter", base_url: "https://openrouter.ai/api/v1", needsKey: true, hint: "Free key at openrouter.ai — many ':free' models available." },
  { id: "groq", name: "Groq", type: "groq", base_url: "https://api.groq.com/openai/v1", needsKey: true, hint: "Free tier at console.groq.com — very fast Llama inference." },
  { id: "gemini", name: "Google Gemini", type: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, hint: "Free key at aistudio.google.com (no credit card). Generous free tier." },
  { id: "ollama", name: "Ollama (local)", type: "ollama", base_url: "http://localhost:11434/v1", needsKey: false, hint: "Local models via Ollama. 100% free, no key. Run: ollama serve" },
  { id: "omniroute", name: "OmniRoute (local)", type: "openai-compat", base_url: "http://localhost:20128/v1", needsKey: false, hint: "Local OmniRoute instance (npm i -g omniroute). Use its legitimate free providers only." },
  { id: "openai", name: "OpenAI (direct)", type: "openai-compat", base_url: "https://api.openai.com/v1", needsKey: true, hint: "Direct OpenAI API — paid key from platform.openai.com." },
  { id: "anthropic", name: "Anthropic (direct)", type: "anthropic", base_url: "https://api.anthropic.com", needsKey: true, hint: "Direct Claude API — paid key from console.anthropic.com." },
  { id: "custom", name: "Custom OpenAI-compatible", type: "openai-compat", base_url: "", needsKey: true, hint: "Any OpenAI-compatible endpoint (New API, one-api, vLLM, LM Studio...)." },
];

router.get("/channels/templates", requireAdmin, (req, res) => {
  res.json({ templates: CHANNEL_TEMPLATES });
});

router.get("/channels", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM channels ORDER BY priority DESC, id ASC").all();
  res.json({
    channels: rows.map(c => ({ ...c, models: parseJson(c.models, []), api_key_masked: maskKey(c.api_key), api_key: undefined })),
  });
});

router.post("/channels", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.type) return res.status(400).json({ error: "name and type required" });
  if (!getProvider(b.type)) return res.status(400).json({ error: "Unknown channel type: " + b.type });
  const info = db.prepare(
    "INSERT INTO channels (name, type, base_url, api_key, models, priority, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(b.name, b.type, b.base_url || "", b.api_key || "", JSON.stringify(b.models || ["*"]), Number(b.priority) || 0, b.status == null ? 1 : (b.status ? 1 : 0));
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.patch("/channels/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Channel not found" });
  const b = req.body || {};
  db.prepare("UPDATE channels SET name=?, base_url=?, api_key=?, models=?, priority=?, status=? WHERE id=?")
    .run(
      b.name ?? row.name,
      b.base_url ?? row.base_url,
      b.api_key != null && b.api_key !== "" ? b.api_key : row.api_key,
      JSON.stringify(b.models || parseJson(row.models, ["*"])),
      Number(b.priority ?? row.priority),
      b.status == null ? row.status : (b.status ? 1 : 0),
      row.id
    );
  res.json({ ok: true });
});

router.delete("/channels/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM channels WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/channels/:id/test", requireAdmin, async (req, res) => {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Channel not found" });
  const provider = getProvider(row.type);
  if (!provider) return res.status(400).json({ error: "Unknown type" });
  let channelModels = [];
  try { channelModels = JSON.parse(row.models || "[]"); } catch (e) {}
  const DEFAULT_TEST_MODELS = {
    mock: "mock-chat",
    tokenrouter: "z-ai/glm-5.3-free",
    openrouter: "google/gemini-2.0-flash-exp:free",
    groq: "llama-3.3-70b-versatile",
    gemini: "gemini-2.5-flash",
    ollama: "llama3.2",
    anthropic: "claude-3-5-haiku-20241022",
  };
  const testModel = (req.body && req.body.model)
    || (channelModels.length && channelModels[0] !== "*" ? channelModels[0] : null)
    || DEFAULT_TEST_MODELS[row.type]
    || "mock-chat";
  const t0 = Date.now();
  try {
    const upstream = await provider.chat({
      channel: row,
      body: provider.kind === "anthropic"
        ? { model: testModel, max_tokens: 32, messages: [{ role: "user", content: "ping" }] }
        : { model: testModel, max_tokens: 32, messages: [{ role: "user", content: "ping" }] },
    });
    const text = await upstream.text();
    res.json({ ok: true, status: upstream.status, model: testModel, latency_ms: Date.now() - t0, preview: text.slice(0, 300) });
  } catch (e) {
    res.json({ ok: false, model: testModel, error: String(e.message).slice(0, 400), latency_ms: Date.now() - t0 });
  }
});

/* ============================ Users (admin) ============================ */
router.get("/users", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT id, username, email, role, quota, used, status, created_at FROM users ORDER BY id").all();
  res.json({ users: rows });
});

router.patch("/users/:id", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });
  const b = req.body || {};
  if (b.quota != null) db.prepare("UPDATE users SET quota = ? WHERE id = ?").run(Math.floor(Number(b.quota)), row.id);
  if (b.status != null) db.prepare("UPDATE users SET status = ? WHERE id = ?").run(b.status ? 1 : 0, row.id);
  if (b.role) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(b.role === "admin" ? "admin" : "user", row.id);
  res.json({ ok: true });
});

/* ============================ Settings (admin) ============================ */
router.get("/settings", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  res.json({ settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

router.put("/settings", requireAdmin, (req, res) => {
  const b = req.body || {};
  const ins = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(b)) ins.run(String(k).slice(0, 64), String(v));
  res.json({ ok: true });
});

/* ============================ Profile ============================ */
router.put("/profile/password", requireUser, (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next) return res.status(400).json({ error: "current and next password required" });
  if (String(next).length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
  if (!verifyPassword(current, req.user.password_hash)) return res.status(401).json({ error: "Current password is incorrect" });
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
