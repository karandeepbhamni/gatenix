"use strict";
/**
 * Mock provider — built-in demo upstream.
 * Works without any API key so the gateway can be tested immediately.
 */

function lastUserText(body) {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map(b => (b && b.text) || "").join(" ");
    }
  }
  return "";
}

function buildReply(body) {
  const input = lastUserText(body).slice(0, 300);
  return (
    `Hello from the Gatenix Mock provider!\n\n` +
    `Model requested: "${body.model}"\n` +
    `Your message: "${input || "(empty)"}"\n\n` +
    `This is a built-in demo response proving your gateway works end-to-end. ` +
    `Add a real channel in the dashboard (TokenRouter, OpenRouter, Google Gemini, Groq, Ollama...) ` +
    `and route real models through the same API.`
  );
}

function estimateTokens(text) {
  return Math.max(1, Math.round(text.length / 4));
}

async function startChat({ body }) {
  const text = buildReply(body);
  const created = Math.floor(Date.now() / 1000);
  const id = "chatcmpl-mock-" + Date.now().toString(36);
  const promptTokens = estimateTokens(lastUserText(body));
  const completionTokens = estimateTokens(text);

  if (body.stream) {
    let sse = "";
    const push = (obj) => { sse += `data: ${JSON.stringify(obj)}\n\n`; };
    push({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    for (const word of text.split(/(?<=\s)/)) {
      push({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
    }
    push({
      id, object: "chat.completion.chunk", created, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    });
    push("[DONE]");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  const json = {
    id, object: "chat.completion", created, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
  return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}

module.exports = { startChat, isMock: true };
