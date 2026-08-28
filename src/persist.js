"use strict";
/**
 * Cloud persistence for the SQLite file.
 *
 * Render's free tier wipes the local disk on every deploy, so this module
 * restores the database from Supabase Storage at boot and uploads a fresh
 * snapshot whenever it changes (plus on shutdown). Without the SUPABASE_URL
 * and SUPABASE_SERVICE_KEY env vars everything here is a no-op and the app
 * runs in local-only mode.
 */
const fs = require("fs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const BUCKET = process.env.SUPABASE_BUCKET || "gatenix-db";
const OBJECT_NAME = "gatenix.db";

function enabled() {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function objectUrl() {
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${OBJECT_NAME}`;
}
const headers = () => ({ Authorization: `Bearer ${SERVICE_KEY}` });

/* Download the backup into dbPath. Returns true when a backup was restored. */
async function restore(dbPath) {
  if (!enabled()) return false;
  try {
    const res = await fetch(objectUrl(), { headers: headers() });
    if (res.status === 404) {
      console.log("[persist] no cloud backup yet — starting with a fresh database");
      return false;
    }
    if (!res.ok) {
      console.warn(`[persist] restore failed (HTTP ${res.status}) — continuing with local database`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) {
      console.warn("[persist] cloud backup looks empty — ignoring it");
      return false;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(dbPath + suffix); } catch {}
    }
    fs.writeFileSync(dbPath, buf);
    console.log(`[persist] restored database from cloud backup (${buf.length} bytes)`);
    return true;
  } catch (e) {
    console.warn("[persist] restore error:", e.message, "— continuing with local database");
    return false;
  }
}

/* Upload a consistent snapshot of the database. Returns true on success. */
async function upload(db, dbPath) {
  if (!enabled()) return false;
  let snapshot = dbPath;
  let tmp = null;
  try {
    if (typeof db.backup === "function") {
      // SQLite online backup — always a consistent snapshot
      tmp = dbPath + ".upload-tmp";
      await db.backup(tmp);
      snapshot = tmp;
    } else {
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    }
    const buf = fs.readFileSync(snapshot);
    const res = await fetch(objectUrl(), {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: buf,
    });
    if (!res.ok) {
      console.warn(`[persist] upload failed (HTTP ${res.status})`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[persist] upload error:", e.message);
    return false;
  } finally {
    if (tmp) { try { fs.rmSync(tmp); } catch {} }
  }
}

module.exports = { enabled, restore, upload };
