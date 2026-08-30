// SAST fixture — the SAFE counterpart to vulnerable/app.js.
//
// Every handler here is the correctly-written version of one directly above it
// in the vulnerable fixture. This file is the more important of the two: a
// scanner that finds all fifteen real defects is worthless if it also fires on
// the fixed code, because then the fix does not clear the finding and nobody
// trusts the tool.
//
// The suppression test asserts ZERO findings across this file. When a new rule
// is added, this is where its benign spelling belongs.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const crypto = require("crypto");
const yaml = require("js-yaml");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const DOMPurify = require("dompurify");

const app = express();
const FILE_ROOT = "/srv/files";
const ALLOWED_PREVIEW_HOSTS = new Set(["images.example.com", "cdn.example.com"]);

// --- injection, parameterized ----------------------------------------------

app.get("/users/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.query("SELECT * FROM users WHERE id = ?", [id], (err, rows) => res.json(rows));
});

app.get("/search", requireAuth, (req, res) => {
  db.query("SELECT * FROM items WHERE name LIKE ?", ["%" + req.query.q + "%"],
    (e, r) => res.json(r));
});

// An argument array: no shell, so no metacharacter to inject.
app.get("/logs", requireAuth, (req, res) => {
  const name = allowlistLogName(req.query.file);
  execFile("tail", ["-n", "100", path.join("/var/log", name)], (err, out) => res.send(out));
});

// A dispatch table instead of eval.
const OPERATIONS = { add: (a, b) => a + b, mul: (a, b) => a * b };
app.post("/calc", requireAuth, (req, res) => {
  const op = OPERATIONS[String(req.body.op)];
  if (!op) return res.status(400).json({ error: "unknown_operation" });
  res.json({ answer: op(Number(req.body.a), Number(req.body.b)) });
});

// Coerced to a primitive, so no operator can be injected.
app.post("/login-lookup", requireAuth, (req, res) => {
  users.findOne({ email: String(req.body.email) }).then((u) => res.json(u));
});

// --- traversal and SSRF, contained -----------------------------------------

app.get("/download", requireAuth, (req, res) => {
  const target = path.resolve(FILE_ROOT, String(req.query.name));
  if (!target.startsWith(FILE_ROOT + path.sep)) {
    return res.status(400).json({ error: "invalid_path" });
  }
  fs.readFile(target, (err, buf) => res.send(buf));
});

app.post("/preview", requireAuth, (req, res) => {
  let url;
  try { url = new URL(String(req.body.url)); }
  catch { return res.status(400).json({ error: "invalid_url" }); }
  if (!ALLOWED_PREVIEW_HOSTS.has(url.hostname)) {
    return res.status(403).json({ error: "host_not_allowed" });
  }
  fetch(url.toString(), { redirect: "error" }).then((r) => r.text()).then((t) => res.send(t));
});

// A relative path only — never a caller-supplied absolute URL.
const NEXT_ROUTES = { home: "/", settings: "/settings" };
app.get("/go", (req, res) => {
  res.redirect(NEXT_ROUTES[String(req.query.next)] || "/");
});

// --- xss, encoded ----------------------------------------------------------

app.get("/hello", (req, res) => {
  res.render("hello", { name: req.query.name });   // template auto-escapes
});

function renderBio(el, html) {
  el.innerHTML = DOMPurify.sanitize(html);
}

// --- crypto, correct primitives --------------------------------------------

async function storePassword(user, password) {
  const hashed = await bcrypt.hash(password, 12);
  return db.query("UPDATE users SET pw = ? WHERE id = ?", [hashed, user.id]);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function encryptCard(number, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(number, "utf8"), cipher.final()]);
  return { iv, body, tag: cipher.getAuthTag() };
}

function readToken(token) {
  return jwt.verify(token, PUBLIC_KEY, { algorithms: ["RS256"] });
}

// --- deserialization, data-only --------------------------------------------

function loadConfig(text) {
  return yaml.load(text, { schema: yaml.CORE_SCHEMA, json: true });
}

// --- secrets, injected -----------------------------------------------------

const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID;
const clientSecret = process.env.OAUTH_CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// --- logging, identifiers only ---------------------------------------------

function audit(user) {
  console.log("login attempt", user.id, "password", "***redacted***");
}

// --- configuration, restrictive --------------------------------------------

const ALLOWED_ORIGINS = ["https://app.example.com"];
app.use(cors({
  origin: (origin, cb) => cb(null, ALLOWED_ORIGINS.includes(origin)),
  credentials: true,
}));

const upload = multer({
  dest: "/tmp/uploads",
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === "image/png"),
});
app.post("/upload", requireAuth, upload.single("file"), (req, res) => res.sendStatus(200));

app.post("/session", (req, res) => {
  res.cookie("session_id", newSessionToken(), {
    httpOnly: true, secure: true, sameSite: "lax",
  });
  res.sendStatus(200);
});

// Guarded, and scoped to the caller's own rows.
app.delete("/records/:id", requireAuth, (req, res) => {
  db.query("DELETE FROM records WHERE id = ? AND owner_id = ?",
    [Number(req.params.id), req.session.userId]);
  res.sendStatus(204);
});

module.exports = {
  app, storePassword, newSessionToken, encryptCard, readToken, loadConfig, audit, renderBio,
};
