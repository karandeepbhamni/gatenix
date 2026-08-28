"use strict";
/**
 * Cloud persistence for the SQLite file — survives Render free-tier redeploys.
 *
 * Two interchangeable backends (the first configured one wins):
 *   1. GitHub repo file : GITHUB_BACKUP_TOKEN + GITHUB_BACKUP_REPO (user/repo)
 *   2. Supabase Storage : SUPABASE_URL + SUPABASE_SERVICE_KEY
 *
 * Without either, everything here is a no-op and the app runs local-only.
 */
const fs = require("fs");

/* ---------- backend selection ---------- */
const GH_TOKEN = process.env.GITHUB_BACKUP_TOKEN || "";
const GH_REPO = process.env.GITHUB_BACKUP_REPO || ""; // e.g. "username/gatenix-data"
const GH_PATH = process.env.GITHUB_BACKUP_PATH || "gatenix.db";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SB_BUCKET = process.env.SUPABASE_BUCKET || "gatenix-db";

const backend = GH_TOKEN && GH_REPO ? "github" : SB_URL && SB_KEY ? "supabase" : null;

function enabled() { return backend !== null; }
function backendName() { return backend || "none"; }

/* ---------- shared: consistent snapshot of the db file ---------- */
async function makeSnapshot(db, dbPath) {
  if (typeof db.backup === "function") {
    const tmp = dbPath + ".upload-tmp";
    await db.backup(tmp);
    return { path: tmp, cleanup: () => { try { fs.rmSync(tmp); } catch {} } };
  }
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
  return { path: dbPath, cleanup: () => {} };
}

/* ---------- GitHub backend (Contents API, private repo) ---------- */
let ghSha = null; // sha of the file currently in the repo (required for updates)

const ghHeaders = () => ({
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "gatenix-persist",
});
const GH_API_BASE = (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "");
const ghApiUrl = () => `${GH_API_BASE}/repos/${GH_REPO}/contents/${GH_PATH}`;

async function ghRestore(dbPath) {
  const res = await fetch(ghApiUrl(), { headers: ghHeaders() });
  if (res.status === 404) {
    console.log("[persist] no GitHub backup yet — starting with a fresh database");
    return false;
  }
  if (!res.ok) throw new Error(`GitHub GET failed (HTTP ${res.status})`);
  const json = await res.json();
  if (!json.content) throw new Error("GitHub response has no content");
  const buf = Buffer.from(json.content, "base64");
  if (buf.length < 512) {
    console.warn("[persist] GitHub backup looks empty — ignoring it");
    return false;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix); } catch {}
  }
  fs.writeFileSync(dbPath, buf);
  ghSha = json.sha;
  console.log(`[persist] restored database from GitHub backup (${buf.length} bytes)`);
  return true;
}

async function ghPutOnce(buf) {
  const body = {
    message: `backup: ${GH_PATH} (${new Date().toISOString()})`,
    content: buf.toString("base64"),
  };
  if (ghSha) body.sha = ghSha;
  return fetch(ghApiUrl(), {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ghUpload(db, dbPath) {
  const snapshot = await makeSnapshot(db, dbPath);
  try {
    const buf = fs.readFileSync(snapshot.path);
    let res = await ghPutOnce(buf);
    if (res.status === 409) {
      // sha mismatch — refetch current sha and retry once
      const cur = await fetch(ghApiUrl(), { headers: ghHeaders() });
      if (cur.ok) ghSha = (await cur.json()).sha;
      else if (cur.status === 404) ghSha = null;
      res = await ghPutOnce(buf);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`GitHub PUT failed (HTTP ${res.status}) ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    ghSha = json?.content?.sha || null;
    return true;
  } finally {
    snapshot.cleanup();
  }
}

/* ---------- Supabase backend ---------- */
const sbHeaders = () => ({ Authorization: `Bearer ${SB_KEY}` });
const sbObjectUrl = () => `${SB_URL}/storage/v1/object/${SB_BUCKET}/gatenix.db`;

async function sbRestore(dbPath) {
  const res = await fetch(sbObjectUrl(), { headers: sbHeaders() });
  if (res.status === 404) {
    console.log("[persist] no Supabase backup yet — starting with a fresh database");
    return false;
  }
  if (!res.ok) throw new Error(`Supabase GET failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512) {
    console.warn("[persist] Supabase backup looks empty — ignoring it");
    return false;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix); } catch {}
  }
  fs.writeFileSync(dbPath, buf);
  console.log(`[persist] restored database from Supabase backup (${buf.length} bytes)`);
  return true;
}

async function sbUpload(db, dbPath) {
  const snapshot = await makeSnapshot(db, dbPath);
  try {
    const buf = fs.readFileSync(snapshot.path);
    const res = await fetch(sbObjectUrl(), {
      method: "POST",
      headers: { ...sbHeaders(), "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: buf,
    });
    if (!res.ok) throw new Error(`Supabase PUT failed (HTTP ${res.status})`);
    return true;
  } finally {
    snapshot.cleanup();
  }
}

/* ---------- dispatch ---------- */
async function restore(dbPath) {
  if (!enabled()) return false;
  try {
    return backend === "github" ? await ghRestore(dbPath) : await sbRestore(dbPath);
  } catch (e) {
    console.warn(`[persist] restore error (${backend}):`, e.message, "— continuing with local database");
    return false;
  }
}

async function upload(db, dbPath) {
  if (!enabled()) return false;
  try {
    return backend === "github" ? await ghUpload(db, dbPath) : await sbUpload(db, dbPath);
  } catch (e) {
    console.warn(`[persist] upload error (${backend}):`, e.message);
    return false;
  }
}

module.exports = { enabled, backendName, restore, upload };
