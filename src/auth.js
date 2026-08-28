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

/* Housekeeping: purge expired sessions occasionally */
setInterval(() => {
  try { db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()); } catch {}
}, 60 * 60 * 1000).unref();

module.exports = { router, requireUser, requireAdmin, publicUser, getSessionUser };
