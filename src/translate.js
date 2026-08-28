"use strict";
/**
 * Protocol translation between OpenAI Chat Completions and Anthropic Messages formats.
 * Lets any OpenAI-compatible channel answer Claude-protocol requests and vice versa.
 */
const { Transform } = require("stream");

/* ============================ Request translation ============================ */
function openAIToAnthropicRequest(body) {
  const messages = [];
  let system;
  for (const m of body.messages || []) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "system" || m.role === "developer") {
      system = system ? system + "\n" + content : content;
    } else {
      messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
    }
  }
  const out = { model: body.model, messages, max_tokens: body.max_tokens || 4096 };
  if (system) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stream) out.stream = true;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return out;
}

function anthropicToOpenAIRequest(body) {
  const messages = [];
  if (body.system) {
    messages.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  }
  for (const m of body.messages || []) {
    let content = m.content;
    if (Array.isArray(content)) content = content.map(b => (b && b.type === "text" ? b.text : "")).join("");
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: content ?? "" });
  }
  const out = { model: body.model, messages };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stream) out.stream = true;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  return out;
}

/* ============================ Response translation (non-stream) ============================ */
function anthropicToOpenAIResponse(json, fallbackModel) {
  const text = (json.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const inTok = json.usage?.input_tokens || 0;
  const outTok = json.usage?.output_tokens || 0;
  return {
    id: json.id || "chatcmpl-" + Date.now().toString(36),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: json.model || fallbackModel,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: json.stop_reason === "max_tokens" ? "length" : "stop",
    }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

function openAIToAnthropicResponse(json, fallbackModel) {
  const choice = json.choices?.[0];
  return {
    id: "msg_" + (json.id || Date.now().toString(36)),
    type: "message",
    role: "assistant",
    model: json.model || fallbackModel,
    content: [{ type: "text", text: choice?.message?.content || "" }],
    stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens || 0,
      output_tokens: json.usage?.completion_tokens || 0,
    },
  };
}

/* ============================ SSE stream translation ============================ */
class SSELineTransform extends Transform {
  constructor(onLine) {
    super({ decodeStrings: false });
    this._buf = "";
    this._onLine = onLine;
  }
  _transform(chunk, _enc, cb) {
    this._buf += chunk.toString("utf8");
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx).replace(/\r$/, "");
      this._buf = this._buf.slice(idx + 1);
      if (line) this._onLine(line, out => this.push(out));
    }
    cb();
  }
  _flush(cb) {
    if (this._buf.trim()) this._onLine(this._buf, out => this.push(out));
    cb();
  }
}

/** OpenAI SSE chunks -> Anthropic SSE events */
function openAIStreamToAnthropic(fallbackModel) {
  let started = false, blockOpen = false, inputTokens = 0, outputTokens = 0, model = fallbackModel;
  const msgId = "msg_" + Date.now().toString(36);
  return new SSELineTransform((line, push) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    const close = () => {
      if (blockOpen) {
        push('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        blockOpen = false;
      }
      push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
      push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    };
    if (data === "[DONE]") { if (started) close(); return; }
    let json; try { json = JSON.parse(data); } catch { return; }
    if (json.usage) {
      inputTokens = json.usage.prompt_tokens ?? inputTokens;
      outputTokens = json.usage.completion_tokens ?? outputTokens;
    }
    if (json.model) model = json.model;
    if (!started) {
      started = true;
      push(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })}\n\n`);
      push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      push(`event: ping\ndata: {"type":"ping"}\n\n`);
      blockOpen = true;
    }
    const delta = json.choices?.[0]?.delta?.content;
    if (delta) {
      push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })}\n\n`);
    }
    if (json.choices?.[0]?.finish_reason && !blockOpen) close();
  });
}

/** Anthropic SSE events -> OpenAI SSE chunks */
function anthropicStreamToOpenAI(fallbackModel) {
  const id = "chatcmpl-" + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  let model = fallbackModel, sentRole = false, done = false;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  return new SSELineTransform((line, push) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    let json; try { json = JSON.parse(data); } catch { return; }
    const emit = obj => push(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, extra) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }], ...extra });
    switch (json.type) {
      case "message_start":
        model = json.message?.model || model;
        usage.prompt_tokens = json.message?.usage?.input_tokens || 0;
        emit(chunk({ role: "assistant", content: "" }));
        sentRole = true;
        break;
      case "content_block_delta":
        if (json.delta?.type === "text_delta" && json.delta.text) {
          if (!sentRole) { emit(chunk({ role: "assistant", content: "" })); sentRole = true; }
          emit(chunk({ content: json.delta.text }));
        }
        break;
      case "message_delta":
        usage.completion_tokens = json.usage?.output_tokens ?? usage.completion_tokens;
        break;
      case "message_stop":
        if (done) break;
        done = true;
        emit({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
        push("data: [DONE]\n\n");
        break;
      case "error":
        emit(chunk({ content: `\n[upstream error: ${json.error?.message || "unknown"}]` }));
        break;
    }
  });
}

module.exports = {
  openAIToAnthropicRequest,
  anthropicToOpenAIRequest,
  anthropicToOpenAIResponse,
  openAIToAnthropicResponse,
  openAIStreamToAnthropic,
  anthropicStreamToOpenAI,
};
