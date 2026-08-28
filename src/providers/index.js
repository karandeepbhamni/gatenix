"use strict";
/**
 * Provider registry. Channel `type` maps to an adapter.
 * openrouter/tokenrouter/groq/ollama/gemini are OpenAI-compatible
 * endpoints with different default base URLs.
 */
const mock = require("./mock");
const openaiCompat = require("./openai-compat");
const anthropic = require("./anthropic");

const OPENAI_COMPAT_TYPES = ["openai-compat", "openrouter", "tokenrouter", "groq", "ollama", "gemini"];

const providers = {
  mock: { chat: opts => mock.startChat(opts), kind: "openai" },
  "openai-compat": { chat: opts => openaiCompat.startChat({ ...opts, type: "openai-compat" }), kind: "openai" },
  anthropic: { chat: opts => anthropic.startChat(opts), kind: "anthropic" },
};
for (const t of ["openrouter", "tokenrouter", "groq", "ollama", "gemini"]) {
  providers[t] = { chat: opts => openaiCompat.startChat({ ...opts, type: t }), kind: "openai" };
}

function getProvider(type) {
  return providers[type] || null;
}

module.exports = { providers, getProvider, OPENAI_COMPAT_TYPES };
