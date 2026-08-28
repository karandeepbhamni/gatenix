"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "gatenix.db");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

/* Migrations (idempotent) */
{
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes("github_id")) db.exec("ALTER TABLE users ADD COLUMN github_id TEXT");
  if (!userCols.includes("google_id")) db.exec("ALTER TABLE users ADD COLUMN google_id TEXT");
}

/* ============================ Schema ============================ */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  quota INTEGER NOT NULL DEFAULT 1000000,
  used INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token_key TEXT UNIQUE NOT NULL,
  quota INTEGER NOT NULL DEFAULT -1,
  used INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  vendor TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  pricing_type TEXT NOT NULL DEFAULT 'token',
  price_input REAL NOT NULL DEFAULT 0,
  price_output REAL NOT NULL DEFAULT 0,
  price_request REAL NOT NULL DEFAULT 0,
  context_length INTEGER NOT NULL DEFAULT 128000,
  endpoints TEXT NOT NULL DEFAULT '["openai"]',
  group_name TEXT NOT NULL DEFAULT 'default',
  tags TEXT NOT NULL DEFAULT '[]',
  status INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  token_id INTEGER,
  channel_id INTEGER,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT 'chat',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL DEFAULT 200,
  error TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_key ON api_tokens(token_key);
`);

/* ============================ Helpers ============================ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}
function newApiKey() {
  return "sk-" + crypto.randomBytes(24).toString("hex");
}

/* ============================ Seed ============================ */
function seed() {
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount === 0) {
    db.prepare(
      "INSERT INTO users (username, email, password_hash, role, quota) VALUES (?, ?, ?, 'admin', ?)"
    ).run("admin", "admin@gatenix.local", hashPassword("admin123"), 100_000_000);
    console.log("[seed] admin user created  ->  username: admin  password: admin123");
  }

  const channelCount = db.prepare("SELECT COUNT(*) AS c FROM channels").get().c;
  if (channelCount === 0) {
    const ins = db.prepare(
      "INSERT INTO channels (name, type, base_url, api_key, models, priority, status) VALUES (?, ?, ?, ?, ?, ?, 1)"
    );
    ins.run("Mock Provider (Demo)", "mock", "", "", JSON.stringify(["*"]), 0);
    console.log("[seed] mock channel created (works without any API key)");
  }

  const modelCount = db.prepare("SELECT COUNT(*) AS c FROM models").get().c;
  if (modelCount === 0) {
    const ins = db.prepare(
      `INSERT INTO models (model_id, display_name, vendor, description, pricing_type,
        price_input, price_output, price_request, context_length, endpoints, group_name, tags, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    const rows = [
      // ---- Mock demo models (work instantly, no key needed) ----
      ["mock-chat", "Mock Chat", "Gatenix", "Built-in demo model. Routes to the Mock provider — no API key needed.", "free", 0, 0, 0, 128000, '["openai","anthropic"]', "default", '["demo","free"]'],
      ["mock-fast", "Mock Fast", "Gatenix", "Fast built-in demo model for testing the gateway.", "free", 0, 0, 0, 32000, '["openai"]', "default", '["demo","free"]'],
      // ---- Real free models (need a free API key in Channels) ----
      ["qwen/qwen3.8-max-free", "Qwen3.8 Max (Free)", "Qwen", "Free tier via TokenRouter. Add a TokenRouter channel with your free key.", "free", 0, 0, 0, 262144, '["openai"]', "default", '["free","reasoning"]'],
      ["google/gemini-2.0-flash-exp:free", "Gemini 2.0 Flash (Free)", "Google", "Free model via OpenRouter.", "free", 0, 0, 0, 1048576, '["openai"]', "default", '["free","multimodal"]'],
      ["meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B (Free)", "Meta", "Free model via OpenRouter.", "free", 0, 0, 0, 131072, '["openai"]', "default", '["free","open-source"]'],
      ["deepseek/deepseek-chat-v3-0324:free", "DeepSeek V3 (Free)", "DeepSeek", "Free model via OpenRouter.", "free", 0, 0, 0, 163840, '["openai"]', "default", '["free","reasoning"]'],
      ["gemini-2.5-flash", "Gemini 2.5 Flash", "Google", "Google AI Studio free tier. Add a Gemini channel with your free key.", "token", 0.3, 2.5, 0, 1048576, '["openai"]', "default", '["free-tier","multimodal"]'],
      ["llama-3.3-70b-versatile", "Llama 3.3 70B Versatile", "Groq", "Groq free tier — very fast inference.", "token", 0.59, 0.79, 0, 128000, '["openai"]', "default", '["free-tier","fast"]'],
      // ---- Paid models (work when a real key/channel is added) ----
      ["claude-opus-5", "Claude Opus 5", "Anthropic", "Requires an Anthropic (or reseller) channel with a valid key.", "per_request", 0, 0, 0.8, 200000, '["anthropic","openai"]', "vip", '["reasoning"]'],
      ["gpt-5", "GPT-5", "OpenAI", "Requires an OpenAI-compatible channel with a valid key.", "token", 1.25, 10, 0, 400000, '["openai"]', "vip", '["frontier"]'],
    ];
    for (const r of rows) ins.run(...r);
    console.log(`[seed] ${rows.length} models created`);
  }

  const settingCount = db.prepare("SELECT COUNT(*) AS c FROM settings").get().c;
  if (settingCount === 0) {
    const ins = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    ins.run("site_name", "Gatenix");
    ins.run("site_description", "Unified API Gateway for AI Models");
    ins.run("default_user_quota", "500000");
    ins.run("server_address", "");
  }
}
seed();

module.exports = { db, hashPassword, verifyPassword, newApiKey };
