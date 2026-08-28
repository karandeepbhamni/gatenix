"use strict";
const path = require("path");
const express = require("express");

const PORT = process.env.PORT || 3000;

(async () => {
  /* Database first: restores the cloud backup (when configured), creates the
     schema and seeds — before any module that needs the db handle is loaded. */
  const dbModule = require("./src/db");
  await dbModule.init();

  const { router: authRouter } = require("./src/auth");
  const gateway = require("./src/gateway");
  const consoleApi = require("./src/api/console");

  const app = express();

  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));

  /* JSON parse errors -> clean 400 */
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } });
    }
    next(err);
  });

  /* API routes */
  app.use("/api/auth", authRouter);
  app.use("/api", consoleApi);
  app.use(gateway); // /v1/chat/completions, /v1/messages, /v1/models

  /* Static frontend */
  app.use(express.static(path.join(__dirname, "public")));

  /* SPA-ish fallbacks for clean page names */
  const pages = ["pricing", "sign-in", "sign-up", "forgot-password", "dashboard"];
  for (const p of pages) {
    app.get("/" + p, (req, res) => res.sendFile(path.join(__dirname, "public", p + ".html")));
  }

  /* Health */
  app.get("/api/health", (req, res) => res.json({ ok: true, name: "Gatenix", time: new Date().toISOString() }));

  /* 404 for unknown /api and /v1 */
  app.use((req, res) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/v1/")) {
      return res.status(404).json({ error: { message: "Not found", type: "invalid_request_error" } });
    }
    res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
  });

  /* Generic error handler */
  app.use((err, req, res, next) => {
    console.error("[server] unhandled error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
  });

  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════╗
  ║  Gatenix — Unified API Gateway               ║
  ╠══════════════════════════════════════════════╣
  ║  Site:       http://localhost:${PORT}          ║
  ║  Console:    http://localhost:${PORT}/dashboard ║
  ║  API base:   http://localhost:${PORT}/v1        ║
  ║                                              ║
  ║  Default admin ->  admin / admin123          ║
  ╚══════════════════════════════════════════════╝
  `);
  });
})().catch(e => {
  console.error("[server] failed to start:", e);
  process.exit(1);
});
