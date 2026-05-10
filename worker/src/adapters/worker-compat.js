// Polyfills and shims to make the Cloudflare Worker source files run in Node.js.
// Import this BEFORE importing any worker source files.

// Cloudflare Workers have `crypto` as a global. Node 20+ also has it globally,
// but for safety we ensure it's available.
if (typeof globalThis.crypto === "undefined") {
  const { webcrypto } = await import("crypto");
  globalThis.crypto = webcrypto;
}

// Cloudflare Workers have `btoa`/`atob` as globals. Node 20+ has them too.
if (typeof globalThis.btoa === "undefined") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

// TextEncoder / TextDecoder — available in Node 18+
if (typeof globalThis.TextEncoder === "undefined") {
  const { TextEncoder, TextDecoder } = await import("util");
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
