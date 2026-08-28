"use strict";
/**
 * Generic OpenAI-compatible upstream.
 * Covers: OpenAI, TokenRouter, OpenRouter, Groq, Ollama, Google Gemini (OpenAI endpoint),
 * and any New API / one-api style gateway.
 */

const DEFAULT_BASES = {
  "openai-compat": "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  tokenrouter: "https://api.tokenrouter.com/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

async function startChat({ channel, body, type }) {
  const base = (channel.base_url || DEFAULT_BASES[type] || DEFAULT_BASES["openai-compat"]).replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (channel.api_key) headers.authorization = `Bearer ${channel.api_key}`;
  // OpenRouter attribution (optional, harmless)
  if (type === "openrouter") headers["http-referer"] = "https://gatenix.jobsalertsindia.com";

  const payload = { ...body };
  if (payload.stream) payload.stream_options = { include_usage: true };

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const err = new Error(`Upstream ${upstream.status}: ${text.slice(0, 400)}`);
    err.status = upstream.status;
    err.upstreamBody = text.slice(0, 2000);
    throw err;
  }
  return upstream;
}

module.exports = { startChat, DEFAULT_BASES };
