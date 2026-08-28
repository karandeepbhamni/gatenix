# Gatenix — Unified API Gateway for AI Models

A self-hosted AI API gateway in the style of tabitoken.com / New API: one unified API for many AI models, with a dashboard, API keys, channels, quotas, and usage logs.

Built with **Node.js + Express + SQLite** (zero native dependencies — uses Node's built-in `node:sqlite`).

---

## ✨ What you get

| Feature | Details |
|---|---|
| **Unified API** | `POST /v1/chat/completions` (OpenAI format), `POST /v1/messages` (Claude format), `GET /v1/models` |
| **Multi-protocol translation** | Call Claude-format API through OpenAI-compatible channels and vice versa |
| **Streaming** | Full SSE streaming support on both protocols |
| **Channels** | TokenRouter, OpenRouter, Groq, Google Gemini, Ollama, OmniRoute, OpenAI, Anthropic, any OpenAI-compatible endpoint |
| **Auto-fallback** | Requests try channels by priority; if one fails, the next takes over |
| **Dashboard (Console)** | Overview stats, API tokens, request logs, channels, models, users, settings, profile |
| **Model Square** | Public model catalog with search + filters (`/pricing`) |
| **Auth** | Sign-up / sign-in, sessions, admin + user roles |
| **Quotas & billing** | Credit-based quotas (1 credit = $0.000001), per-token & per-request pricing, usage logs |
| **Mock provider** | Built-in demo upstream — works instantly with **zero API keys** |

---

## 🚀 Quick start

Requirements: **Node.js 22.5+** (Node 24 recommended).

```bash
cd gatenix
npm install
npm start
```

Then open:

- **Site:** http://localhost:3000
- **Console:** http://localhost:3000/dashboard
- **Model Square:** http://localhost:3000/pricing

**Default admin account:** `admin` / `admin123` — change the password immediately in *Console → Profile*.

---

## 🔑 Using the API

1. Sign in at `/dashboard` → **Tokens** → **+ New token** → copy the `sk-...` key.
2. Call the gateway:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "mock-chat", "messages": [{"role": "user", "content": "Hello!"}]}'
```

`mock-chat` works instantly (built-in Mock provider). For real models, add a channel (below).

**Claude-protocol clients** (Claude Code style) also work:

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: sk-YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "mock-chat", "max_tokens": 512, "messages": [{"role": "user", "content": "Hi"}]}'
```

Point any OpenAI SDK at `baseURL: "http://localhost:3000/v1"` with your `sk-` key.

---

## 🆓 Real models for FREE (no credit card)

The gateway ships with channel templates. In **Console → Channels → + Add channel**, pick a template, paste your free key, done.

| Provider | Free key from | Notes |
|---|---|---|
| **TokenRouter** | https://www.tokenrouter.com (sign up) | Free model `qwen/qwen3.8-max-free` ($0) + free credits on signup |
| **OpenRouter** | https://openrouter.ai/keys | Many models ending in `:free` cost $0 |
| **Google Gemini** | https://aistudio.google.com | Generous free tier, no credit card |
| **Groq** | https://console.groq.com | Free tier, very fast Llama inference |
| **Ollama** | https://ollama.com | Run models locally — 100% free, no key (`ollama serve`) |
| **OmniRoute** | `npm i -g omniroute` | Local gateway with 90+ legit free tiers (see warning below) |

> ⚠️ **Honest warning about "free Claude":** Claude (Anthropic) is a paid API. There is **no legitimate free source** of Claude API access. Tools that promise "free Claude" via Claude Code / subscription OAuth tokens violate Anthropic's terms and can get your account **banned**. Gatenix's Anthropic adapter is ready for when you have a real key — but don't rely on OAuth tricks.

---

## 🗂 Project structure

```
gatenix/
├── server.js               # Express entry point
├── package.json
├── src/
│   ├── db.js               # SQLite schema + seed (admin, models, mock channel)
│   ├── auth.js             # Sessions, sign-in/up/out, password hashing (scrypt)
│   ├── gateway.js          # /v1/* routes: auth, quotas, fallback, streaming, logging
│   ├── translate.js        # OpenAI ↔ Anthropic protocol translation
│   ├── providers/
│   │   ├── index.js        # Provider registry
│   │   ├── mock.js         # Built-in demo provider (no key needed)
│   │   ├── openai-compat.js# Generic OpenAI-compatible upstream
│   │   └── anthropic.js    # Native Anthropic upstream
│   └── api/console.js      # Console REST API (tokens, logs, channels, models, users, settings)
├── public/
│   ├── index.html          # Landing page
│   ├── pricing.html        # Model Square
│   ├── sign-in.html / sign-up.html / forgot-password.html
│   ├── dashboard.html      # Console SPA shell
│   └── assets/             # styles.css, app.js, dashboard.js
└── data/gatenix.db         # SQLite database (auto-created)
```

---

## ⚙️ Configuration

- **Port:** set `PORT` env var (default `3000`).
- **Admin password:** Console → Profile → Change password.
- **Site settings:** Console → Settings (site name, default quota for new users).
- **Database:** `data/gatenix.db` — back this file up to preserve users/tokens/logs.

---

## 🌍 Publishing your site

**Do NOT put this on an unrelated domain** (e.g. a jobs-alerts site). Mixing niches hurts SEO and AdSense review. Use a dedicated domain or subdomain.

**Free option (start here, ₹0):**
1. Push this folder to GitHub.
2. Deploy on **Render.com** (free tier runs Node apps) → you get `yourapp.onrender.com`.
3. Set `PORT` via Render's environment settings (Render provides its own port).
4. Note: free tiers sleep after inactivity and the SQLite file lives on ephemeral disk — attach a Render **Disk** for `data/` if you need persistence.

**Paid option (when ready):**
- Buy a cheap domain (Hostinger `.in` / `.com`) and deploy on a VPS (Hostinger VPS, DigitalOcean, Hetzner) with `npm start` behind a reverse proxy (Caddy/nginx) + HTTPS.

**Monetization reality check:**
- AdSense earns ~nothing on an API-tool site (it's a tool, not content).
- API reselling (like tabitoken) requires **upstream API spend first** — you buy tokens from providers and resell with a margin. With zero budget, you can only offer genuinely-free models.
- A more realistic play for an existing niche site: add AI *tools* that fit the niche (resume builder, cover-letter generator) rather than an API gateway.

---

## 🔒 Security notes

- Passwords hashed with `scrypt`; sessions are random 256-bit IDs in HttpOnly cookies.
- Change the default admin password before exposing the site.
- Put HTTPS in front (Render gives it free; on a VPS use Caddy).
- Upstream API keys are stored in the SQLite file — restrict file permissions on a VPS.

---

## 🧪 Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Upgrade Node to 22.5+ (`node --version`) |
| Model says "No channel configured" | Add a channel covering that model in Console → Channels |
| Upstream 401 | Wrong/expired API key in the channel |
| Port already in use | `PORT=3001 npm start` |

---

MIT License. Built as a self-hostable gateway inspired by the open-source New API project.
