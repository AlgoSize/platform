// SAST fixture — DELIBERATELY VULNERABLE. Do not copy any of this.
//
// A small Express app whose handlers each contain exactly one defect the
// scanner is expected to find. Every function is reachable-looking and
// idiomatic, because a fixture of obviously-fake one-liners proves the regex
// matches itself rather than proving the scanner works on code people write.
//
// Credential-shaped strings are assembled by concatenation. That is not
// stylistic: a literal in the published format would be caught by GitHub's
// push protection, so a fixture containing one could not be committed at all.
//
// The honest consequence: the scanner does NOT detect these particular lines,
// because a concatenation is not a string literal. Secret detection is
// therefore exercised in scripts/test-sast.mjs against content built in
// memory, where a full-format credential never touches the disk. This file
// covers the categories that CAN be expressed in committed source.
//
// Excluded from live scanning by SOURCE_SKIP_RE in handlers/analyze.js, which
// skips any `fixtures/` directory — otherwise this repository would report its
// own test corpus as vulnerabilities.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const crypto = require("crypto");
const yaml = require("js-yaml");
const multer = require("multer");
const jwt = require("jsonwebtoken");

const app = express();

// --- injection -------------------------------------------------------------

// CWE-89: request data concatenated into SQL. Taint-confirmed by the AST pass.
app.get("/users/:id", (req, res) => {
  const id = req.params.id;
  db.query("SELECT * FROM users WHERE id = " + id, (err, rows) => res.json(rows));
});

// CWE-89 again, via a template literal.
app.get("/search", (req, res) => {
  const term = req.query.q;
  db.query(`SELECT * FROM items WHERE name LIKE '%${term}%'`, (e, r) => res.json(r));
});

// CWE-78: request data reaches a shell.
app.get("/logs", (req, res) => {
  exec("tail -n 100 /var/log/" + req.query.file, (err, out) => res.send(out));
});

// CWE-95: dynamic evaluation of request data.
app.post("/calc", (req, res) => {
  const answer = eval(req.body.expression);
  res.json({ answer });
});

// CWE-943: the raw body becomes a query document, so `{"$ne": null}` matches all.
app.post("/login-lookup", (req, res) => {
  users.findOne(req.body).then((u) => res.json(u));
});

// --- traversal and SSRF ----------------------------------------------------

// CWE-22: a path built from request data.
app.get("/download", (req, res) => {
  fs.readFile(path.join("/srv/files", req.query.name), (err, buf) => res.send(buf));
});

// CWE-918: a server-side request to a URL the caller chose.
app.post("/preview", (req, res) => {
  fetch(req.body.url).then((r) => r.text()).then((t) => res.send(t));
});

// CWE-601: an unvalidated redirect target.
app.get("/go", (req, res) => {
  res.redirect(req.query.next);
});

// --- xss -------------------------------------------------------------------

// CWE-79: request data reflected into an HTML response.
app.get("/hello", (req, res) => {
  res.send("<h1>Hello " + req.query.name + "</h1>");
});

// --- crypto ----------------------------------------------------------------

// CWE-916: a password put through a fast digest.
function storePassword(user, password) {
  const hashed = crypto.createHash("sha256").update(password).digest("hex");
  return db.query("UPDATE users SET pw = ? WHERE id = ?", [hashed, user.id]);
}

// CWE-338: a session token from a predictable PRNG.
function newSessionToken() {
  return Math.random().toString(36).slice(2);
}

// CWE-327: a broken cipher in a mode that leaks plaintext structure.
function encryptCard(number) {
  const cipher = crypto.createCipheriv("aes-128-ecb", KEY, null);
  return cipher.update(number, "utf8", "hex") + cipher.final("hex");
}

// CWE-347: the signature is never checked.
function readToken(token) {
  return jwt.decode(token);
}

// --- deserialization -------------------------------------------------------

// CWE-502: a loader that can construct arbitrary objects.
function loadConfig(text) {
  return yaml.load(text);
}

// --- secrets ---------------------------------------------------------------

// CWE-798. Split so the fixture itself can be committed; see the file header.
const AWS_ACCESS_KEY = "AKIA" + "IOSFODNN7" + "EXAMPLE";
const clientSecret = "8f4c2b91" + "d7e6a03f" + "5b1c9e82";
const DATABASE_URL = "postgres://appuser:" + "s3cr3tp4ss" + "@db.internal:5432/prod";

// --- logging ---------------------------------------------------------------

// CWE-532: the credential itself reaches the log.
function audit(user, password) {
  console.log("login attempt", user.email, "password", password);
}

// --- configuration ---------------------------------------------------------

// CWE-942: any origin, with credentials.
app.use(cors({ origin: "*", credentials: true }));

// CWE-434: uploads with neither a size cap nor a type filter.
const upload = multer({ dest: "/tmp/uploads" });
app.post("/upload", upload.single("file"), (req, res) => res.sendStatus(200));

// CWE-1004: a session cookie readable by script.
app.post("/session", (req, res) => {
  res.cookie("session_id", newSessionToken(), { httpOnly: false, secure: false });
  res.sendStatus(200);
});

// CWE-306: a state-changing route with no middleware and no visible check.
app.delete("/records/:id", (req, res) => {
  db.query("DELETE FROM records WHERE id = ?", [req.params.id]);
  res.sendStatus(204);
});

module.exports = { app, storePassword, newSessionToken, encryptCard, readToken, loadConfig, audit };
