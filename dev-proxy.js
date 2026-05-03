#!/usr/bin/env node
// dev-proxy.js — Replit development reverse-proxy.
//
// The Jekyll site bakes window.ALGOSIZE_API_BASE = "" (same-origin) so every
// fetch goes to the same host the browser loaded the page from.  This proxy
// sits on port 5000 (the Replit-visible port) and routes:
//
//   /api/*  → Cloudflare Worker dev server (wrangler dev, port 8787)
//   *       → Jekyll dev server              (port 8080)
//
// Same-origin requests carry no CORS constraints, so the Worker's strict
// CORS allow-list doesn't need to be touched for local dev.

"use strict";
const http = require("http");

const PROXY_PORT  = 5000;
const JEKYLL_PORT = 8080;
const WORKER_PORT = 8787;

function targetPort(url) {
  return url.startsWith("/api/") ? WORKER_PORT : JEKYLL_PORT;
}

function forward(req, res, port) {
  const opts = {
    hostname : "127.0.0.1",
    port,
    path     : req.url,
    method   : req.method,
    headers  : Object.assign({}, req.headers, { host: `127.0.0.1:${port}` }),
  };

  const upstream = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res, { end: true });
  });

  upstream.on("error", (err) => {
    const svc = port === WORKER_PORT ? "worker (wrangler)" : "jekyll";
    console.error(`[proxy] ${svc}:${port} unreachable — ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Dev proxy: ${svc} not ready yet.\n${err.message}\n`);
    }
  });

  req.pipe(upstream, { end: true });
}

const server = http.createServer((req, res) => {
  forward(req, res, targetPort(req.url));
});

// Forward WebSocket upgrades (Jekyll livereload uses WS on the same port).
server.on("upgrade", (req, socket, _head) => {
  const port = targetPort(req.url);
  const opts = {
    hostname : "127.0.0.1",
    port,
    path     : req.url,
    method   : req.method,
    headers  : req.headers,
  };

  const upstream = http.request(opts);
  upstream.on("upgrade", (upRes, upSocket) => {
    const status = `HTTP/1.1 101 Switching Protocols\r\n`;
    const hdrs   = Object.entries(upRes.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    socket.write(status + hdrs + "\r\n\r\n");
    upSocket.pipe(socket, { end: false });
    socket.pipe(upSocket, { end: false });
    socket.on("error", () => upSocket.destroy());
    upSocket.on("error", () => socket.destroy());
  });

  upstream.on("error", () => socket.destroy());
  upstream.end();
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(
    `[proxy] :${PROXY_PORT}  →  jekyll::${JEKYLL_PORT}  |  worker::${WORKER_PORT}`
  );
});
