"use strict";
/**
 * Gatenix API Gateway
 * Unified routes: /v1/chat/completions (OpenAI), /v1/messages (Anthropic), /v1/models
 * Features: key auth, quotas, channel fallback, streaming SSE, protocol translation, usage logging.
 */
const express = require("express");
const { Readable } = require("stream");
const { db } = require("./db");
const { getProvider } = require("./providers");
const T = require("./translate");

const router = express.Router();

/* ============================ Auth & quota ============================ */
function extractApiKey(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return null;
}

function authApiToken(req, res) {
  const key = extractApiKey(req);
  if (!key) {
    res.status(401).json({ error: { message: "Missing API key. Send 'Authorization: Bearer sk-...' or 'x-api-key' header.", type: "auth_error" } });
    return null;
  }
  const row = db.prepare(
    `SELECT t.*, u.id AS uid, u.role, u.quota AS uquota, u.used AS uused, u.status AS ustatus
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_key = ?`
  ).get(key);
  if (!row) { res.status(401).json({ error: { message: "Invalid API key.", type: "auth_error" } }); return null; }
  if (row.status !== 1 || row.ustatus !== 1) { res.status(403).json({ error: { message: "API key or account is disabled.", type: "auth_error" } }); return null; }
  if (row.quota !== -1 && row.used >= row.quota) { res.status(429).json({ error: { message: "API key quota exhausted.", type: "quota_error" } }); return null; }
  if (row.uquota !== -1 && row.uused >= row.uquota) { res.status(429).json({ error: { message: "Account quota exhausted.", type: "quota_error" } }); return null; }
  return row;
}

/* ============================ Channel resolution ============================ */
function resolveChannels(modelId) {
  const all = db.prepare("SELECT * FROM channels WHERE status = 1 ORDER BY priority DESC, id ASC").all();
  return all.filter(ch => {
    try {
      const models = JSON.parse(ch.models || "[]");
      return models.includes("*") || models.includes(modelId);
    } catch { return false; }
  });
}

/* ============================ Usage helpers ============================ */
const estimateTokens = text => Math.max(1, Math.round((text || "").length / 4));

function requestPromptTokens(body) {
  let chars = 0;
  for (const m of body.messages || []) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }
  if (body.system) chars += typeof body.system === "string" ? body.system.length : JSON.stringify(body.system).length;
  if (body.input) chars += JSON.stringify(body.input).length;
  return Math.max(1, Math.round(chars / 4));
}

function computeCost(modelRow, promptTokens, completionTokens) {
  if (!modelRow || modelRow.pricing_type === "free") return 0;
  if (modelRow.pricing_type === "per_request") return modelRow.price_request || 0;
  return (promptTokens / 1e6) * (modelRow.price_input || 0) + (completionTokens / 1e6) * (modelRow.price_output || 0);
}

function writeLog({ tokenRow, channelId, model, endpoint, promptTokens, completionTokens, cost, statusCode, error, latencyMs }) {
  try {
    db.prepare(
      `INSERT INTO logs (user_id, token_id, channel_id, model, endpoint, prompt_tokens, completion_tokens, cost, status_code, error, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenRow.uid, tokenRow.id, channelId, model, endpoint, promptTokens || 0, completionTokens || 0, cost || 0, statusCode, error || null, latencyMs || 0);
    const credits = Math.round((cost || 0) * 1e6); // 1 credit = $0.000001
    if (credits > 0) {
      db.prepare("UPDATE api_tokens SET used = used + ?, last_used_at = datetime('now') WHERE id = ?").run(credits, tokenRow.id);
      db.prepare("UPDATE users SET used = used + ? WHERE id = ?").run(credits, tokenRow.uid);
    } else {
      db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(tokenRow.id);
    }
  } catch (e) {
    console.error("[gateway] log write failed:", e.message);
  }
}

/* ============================ SSE parsing (post-stream usage) ============================ */
function parseOpenAIStream(sseText) {
  let usage = null, text = "";
  for (const line of sseText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:") || s.includes("[DONE]")) continue;
    try {
      const j = JSON.parse(s.slice(5).trim());
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta?.content;
      if (d) text += d;
    } catch {}
  }
  return { usage: usage || {}, text };
}

function parseAnthropicStream(sseText) {
  let input = 0, output = 0, text = "";
  for (const line of sseText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    try {
      const j = JSON.parse(s.slice(5).trim());
      if (j.type === "message_start") input = j.message?.usage?.input_tokens || 0;
      if (j.type === "message_delta") output = j.usage?.output_tokens ?? output;
      if (j.type === "content_block_delta" && j.delta?.text) text += j.delta.text;
    } catch {}
  }
  return { usage: { input_tokens: input, output_tokens: output }, text };
}

function pipeToResponse(nodeStream, res, onData) {
  return new Promise((resolve, reject) => {
    nodeStream.on("data", onData);
    nodeStream.on("end", resolve);
    nodeStream.on("error", reject);
    nodeStream.pipe(res);
  });
}

function setSSEHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

/* ============================ /v1/chat/completions (OpenAI protocol) ============================ */
router.post("/v1/chat/completions", async (req, res) => {
  const t0 = Date.now();
  const tokenRow = authApiToken(req, res);
  if (!tokenRow) return;
  const body = req.body || {};
  const modelId = body.model;
  if (!modelId) return res.status(400).json({ error: { message: "'model' is required.", type: "invalid_request_error" } });

  const modelRow = db.prepare("SELECT * FROM models WHERE model_id = ?").get(modelId) || null;
  const channels = resolveChannels(modelId);
  if (!channels.length) {
    return res.status(404).json({ error: { message: `No channel configured for model "${modelId}". Add one in Dashboard → Channels.`, type: "model_not_found" } });
  }

  const wantsStream = !!body.stream;
  let lastErr = null;

  for (const ch of channels) {
    const provider = getProvider(ch.type);
    if (!provider) continue;
    try {
      let upstreamBody = body, mode = "openai";
      if (provider.kind === "anthropic") {
        upstreamBody = T.openAIToAnthropicRequest(body);
        mode = "anthropic";
      }
      const upstream = await provider.chat({ channel: ch, body: upstreamBody });

      if (wantsStream) {
        setSSEHeaders(res);
        let nodeStream = Readable.fromWeb(upstream.body);
        if (mode === "anthropic") nodeStream = nodeStream.pipe(T.anthropicStreamToOpenAI(modelId));
        let acc = "";
        try {
          await pipeToResponse(nodeStream, res, c => {
            acc += c.toString("utf8");
            if (acc.length > 600000) acc = acc.slice(-300000);
          });
        } catch (pipeErr) {
          if (!res.writableEnded) res.end();
        }
        const { usage, text } = parseOpenAIStream(acc);
        const promptTokens = usage.prompt_tokens || requestPromptTokens(body);
        const completionTokens = usage.completion_tokens || estimateTokens(text);
        writeLog({ tokenRow, channelId: ch.id, model: modelId, endpoint: "chat", promptTokens, completionTokens, cost: computeCost(modelRow, promptTokens, completionTokens), statusCode: 200, latencyMs: Date.now() - t0 });
        return;
      }

      const raw = await upstream.text();
      let json;
      try { json = JSON.parse(raw); } catch { throw new Error("Invalid JSON from upstream: " + raw.slice(0, 200)); }
      if (mode === "anthropic") json = T.anthropicToOpenAIResponse(json, modelId);
      const promptTokens = json.usage?.prompt_tokens || requestPromptTokens(body);
      const completionTokens = json.usage?.completion_tokens || estimateTokens(json.choices?.[0]?.message?.content || "");
      writeLog({ tokenRow, channelId: ch.id, model: modelId, endpoint: "chat", promptTokens, completionTokens, cost: computeCost(modelRow, promptTokens, completionTokens), statusCode: 200, latencyMs: Date.now() - t0 });
      return res.status(200).json(json);
    } catch (err) {
      lastErr = err;
      continue; // try next channel
    }
  }

  writeLog({ tokenRow, channelId: null, model: modelId, endpoint: "chat", promptTokens: 0, completionTokens: 0, cost: 0, statusCode: lastErr?.status || 502, error: String(lastErr?.message || "all channels failed").slice(0, 500), latencyMs: Date.now() - t0 });
  res.status(lastErr?.status || 502).json({ error: { message: `All channels failed for "${modelId}": ${lastErr?.message || "unknown error"}`, type: "upstream_error" } });
});

/* ============================ /v1/messages (Anthropic protocol) ============================ */
router.post("/v1/messages", async (req, res) => {
  const t0 = Date.now();
  const tokenRow = authApiToken(req, res);
  if (!tokenRow) return;
  const body = req.body || {};
  const modelId = body.model;
  if (!modelId) return res.status(400).json({ error: { type: "invalid_request_error", message: "'model' is required." } });

  const modelRow = db.prepare("SELECT * FROM models WHERE model_id = ?").get(modelId) || null;
  let channels = resolveChannels(modelId);
  if (!channels.length) {
    return res.status(404).json({ error: { type: "not_found_error", message: `No channel configured for model "${modelId}". Add one in Dashboard → Channels.` } });
  }
  // prefer native Anthropic channels, then OpenAI-compatible (translated)
  channels = [...channels].sort((a, b) => Number(b.type === "anthropic") - Number(a.type === "anthropic"));

  const wantsStream = !!body.stream;
  let lastErr = null;

  for (const ch of channels) {
    const provider = getProvider(ch.type);
    if (!provider) continue;
    try {
      let upstreamBody = body, mode = "anthropic";
      if (provider.kind === "openai") {
        upstreamBody = T.anthropicToOpenAIRequest(body);
        mode = "openai";
      }
      const upstream = await provider.chat({ channel: ch, body: upstreamBody });

      if (wantsStream) {
        setSSEHeaders(res);
        let nodeStream = Readable.fromWeb(upstream.body);
        if (mode === "openai") nodeStream = nodeStream.pipe(T.openAIStreamToAnthropic(modelId));
        let acc = "";
        try {
          await pipeToResponse(nodeStream, res, c => {
            acc += c.toString("utf8");
            if (acc.length > 600000) acc = acc.slice(-300000);
          });
        } catch (pipeErr) {
          if (!res.writableEnded) res.end();
        }
        const { usage, text } = parseAnthropicStream(acc);
        const promptTokens = usage.input_tokens || requestPromptTokens(body);
        const completionTokens = usage.output_tokens || estimateTokens(text);
        writeLog({ tokenRow, channelId: ch.id, model: modelId, endpoint: "messages", promptTokens, completionTokens, cost: computeCost(modelRow, promptTokens, completionTokens), statusCode: 200, latencyMs: Date.now() - t0 });
        return;
      }

      const raw = await upstream.text();
      let json;
      try { json = JSON.parse(raw); } catch { throw new Error("Invalid JSON from upstream: " + raw.slice(0, 200)); }
      if (mode === "openai") json = T.openAIToAnthropicResponse(json, modelId);
      const promptTokens = json.usage?.input_tokens || requestPromptTokens(body);
      const completionTokens = json.usage?.output_tokens || estimateTokens((json.content || []).map(b => b.text || "").join(""));
      writeLog({ tokenRow, channelId: ch.id, model: modelId, endpoint: "messages", promptTokens, completionTokens, cost: computeCost(modelRow, promptTokens, completionTokens), statusCode: 200, latencyMs: Date.now() - t0 });
      return res.status(200).json(json);
    } catch (err) {
      lastErr = err;
      continue;
    }
  }

  writeLog({ tokenRow, channelId: null, model: modelId, endpoint: "messages", promptTokens: 0, completionTokens: 0, cost: 0, statusCode: lastErr?.status || 502, error: String(lastErr?.message || "all channels failed").slice(0, 500), latencyMs: Date.now() - t0 });
  res.status(lastErr?.status || 502).json({ error: { type: "api_error", message: `All channels failed for "${modelId}": ${lastErr?.message || "unknown error"}` } });
});

/* ============================ /v1/models ============================ */
router.get("/v1/models", (req, res) => {
  const rows = db.prepare("SELECT model_id, vendor FROM models WHERE status = 1 ORDER BY model_id").all();
  res.json({
    object: "list",
    data: rows.map(r => ({ id: r.model_id, object: "model", created: 0, owned_by: r.vendor || "gatenix" })),
  });
});

module.exports = router;
