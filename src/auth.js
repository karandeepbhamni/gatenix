"use strict";
const crypto = require("crypto");
const express = require("express");
const { db, hashPassword, verifyPassword } = require("./db");

const router = express.Router();
const COOKIE_NAME = "nexus_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ============================ Cookies ============================ */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, id) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ============================ Session ============================ */
function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    id, userId, Date.now() + SESSION_TTL_MS
  );
  return id;
}
function getSessionUser(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  ).get(sid, Date.now());
  return row || null;
}
function requireUser(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  if (user.status !== 1) return res.status(403).json({ error: "Account disabled" });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    next();
  });
}
function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, quota: u.quota, used: u.used, created_at: u.created_at };
}

/* ============================ Routes ============================ */
router.post("/signup", (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (String(username).length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const exists = db.prepare("SELECT id FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)").get(username, email || null);
  if (exists) return res.status(409).json({ error: "Username or email already taken" });
  const quota = Number(db.prepare("SELECT value FROM settings WHERE key = 'default_user_quota'").get()?.value || 500000);
  const info = db.prepare(
    "INSERT INTO users (username, email, password_hash, role, quota) VALUES (?, ?, ?, 'user', ?)"
  ).run(String(username).trim(), email ? String(email).trim() : null, hashPassword(password), quota);
  const sid = createSession(info.lastInsertRowid);
  setSessionCookie(res, sid);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  res.json({ ok: true, user: publicUser(user) });
});

router.post("/signin", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  const user = db.prepare("SELECT * FROM users WHERE username = ? OR email = ?").get(username, username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  if (user.status !== 1) return res.status(403).json({ error: "Account disabled" });
  const sid = createSession(user.id);
  setSessionCookie(res, sid);
  res.json({ ok: true, user: publicUser(user) });
});

router.post("/signout", (req, res) => {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (sid) db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ user: publicUser(user) });
});

/* ============================ Social login (OAuth) ============================ */
function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || "";
}
function originOf(req) {
  return `${req.protocol}://${req.get("host")}`;
}
const STATE_COOKIE = "nexus_oauth_state";
function setStateCookie(res, state) {
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
}
function takeState(req) {
  const state = parseCookies(req)[STATE_COOKIE] || "";
  return state;
}
function clearStateCookie(res) {
  res.setHeader("Set-Cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function upsertOAuthUser({ provider, providerId, username, email, name }) {
  const idCol = provider === "github" ? "github_id" : "google_id";
  let user = db.prepare(`SELECT * FROM users WHERE ${idCol} = ?`).get(providerId);
  if (!user && email) user = db.prepare("SELECT email FROM users WHERE email = ?").get(email)
    ? db.prepare("SELECT * FROM users WHERE email = ?").get(email) : null;
  if (user) {
    db.prepare(`UPDATE users SET ${idCol} = ? WHERE id = ?`).run(providerId, user.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(user.id);
  }
  let uname = String(username || email?.split("@")[0] || `${provider}_user`).trim().slice(0, 32);
  const clash = db.prepare("SELECT id FROM users WHERE username = ?").get(uname);
  if (clash) uname = `${uname}_${crypto.randomBytes(3).toString("hex")}`;
  const quota = Number(getSetting("default_user_quota") || 500000);
  const randomPw = hashPassword(crypto.randomBytes(32).toString("hex"));
  const info = db.prepare(
    `INSERT INTO users (username, email, password_hash, role, quota, ${idCol}) VALUES (?, ?, ?, 'user', ?, ?)`
  ).run(uname, email || null, randomPw, quota, providerId);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

router.get("/providers", (req, res) => {
  res.json({
    github: Boolean(getSetting("github_client_id")),
    google: Boolean(getSetting("google_client_id")),
  });
});

/* ---- GitHub ---- */
router.get("/github", (req, res) => {
  const clientId = getSetting("github_client_id");
  if (!clientId) return res.status(404).json({ error: "GitHub login is not configured" });
  const state = crypto.randomBytes(16).toString("hex");
  setStateCookie(res, state);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${originOf(req)}/api/auth/github/callback`);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

router.get("/github/callback", async (req, res) => {
  const fail = (msg) => res.redirect(`/sign-in?oauth_error=${encodeURIComponent(msg)}`);
  try {
    const { code, state } = req.query;
    const saved = takeState(req);
    clearStateCookie(res);
    if (!code || !saved || state !== saved) return fail("OAuth state mismatch. Try again.");
    const clientId = getSetting("github_client_id");
    const secret = getSetting("github_client_secret");
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code, redirect_uri: `${originOf(req)}/api/auth/github/callback` }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) return fail(tokenJson.error_description || "GitHub token exchange failed");
    const auth = { Authorization: `Bearer ${tokenJson.access_token}`, "User-Agent": "Gatenix", Accept: "application/vnd.github+json" };
    const ghUser = await (await fetch("https://api.github.com/user", { headers: auth })).json();
    let email = ghUser.email;
    if (!email) {
      const emails = await (await fetch("https://api.github.com/user/emails", { headers: auth })).json();
      if (Array.isArray(emails)) email = (emails.find(e => e.primary && e.verified) || emails[0] || {}).email || null;
    }
    const user = upsertOAuthUser({ provider: "github", providerId: String(ghUser.id), username: ghUser.login, email, name: ghUser.name });
    if (user.status !== 1) return fail("Account disabled");
    setSessionCookie(res, createSession(user.id));
    res.redirect("/dashboard");
  } catch (e) {
    fail(e.message || "GitHub login failed");
  }
});

/* ---- Google ---- */
router.get("/google", (req, res) => {
  const clientId = getSetting("google_client_id");
  if (!clientId) return res.status(404).json({ error: "Google login is not configured" });
  const state = crypto.randomBytes(16).toString("hex");
  setStateCookie(res, state);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${originOf(req)}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

router.get("/google/callback", async (req, res) => {
  const fail = (msg) => res.redirect(`/sign-in?oauth_error=${encodeURIComponent(msg)}`);
  try {
    const { code, state } = req.query;
    const saved = takeState(req);
    clearStateCookie(res);
    if (!code || !saved || state !== saved) return fail("OAuth state mismatch. Try again.");
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: getSetting("google_client_id"), client_secret: getSetting("google_client_secret"),
        redirect_uri: `${originOf(req)}/api/auth/google/callback`, grant_type: "authorization_code",
      }).toString(),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenJson.access_token) return fail(tokenJson.error_description || "Google token exchange failed");
    const info = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    })).json();
    if (!info.sub) return fail("Could not read Google profile");
    const user = upsertOAuthUser({ provider: "google", providerId: String(info.sub), username: info.preferred_username || info.name || info.email, email: info.email, name: info.name });
    if (user.status !== 1) return fail("Account disabled");
    setSessionCookie(res, createSession(user.id));
    res.redirect("/dashboard");
  } catch (e) {
    fail(e.message || "Google login failed");
  }
});

/* Housekeeping: purge expired sessions occasionally */
setInterval(() => {
  try { db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()); } catch {}
}, 60 * 60 * 1000).unref();

module.exports = { router, requireUser, requireAdmin, publicUser, getSessionUser };
