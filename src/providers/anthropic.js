"use strict";
/**
 * Anthropic (Claude) upstream — native /v1/messages protocol.
 * Requires a valid Anthropic API key (or a reseller channel speaking the Anthropic protocol).
 */

async function startChat({ channel, body }) {
  const base = (channel.base_url || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const headers = {
    "content-type": "application/json",
    "anthropic-version": body.anthropic_version || "2023-06-01",
  };
  if (channel.api_key) headers["x-api-key"] = channel.api_key;

  const payload = { ...body };
  delete payload.anthropic_version;
  if (!payload.max_tokens) payload.max_tokens = 4096;

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

module.exports = { startChat };
