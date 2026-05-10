// In-memory KV store that mimics the Cloudflare KV API surface.
// Supports TTL-based expiration.

class KVNamespace {
  constructor(name) {
    this.name = name;
    this._store = new Map(); // key -> { value, expiresAt }
  }

  _prune() {
    const now = Date.now();
    for (const [k, v] of this._store.entries()) {
      if (v.expiresAt !== null && now > v.expiresAt) {
        this._store.delete(k);
      }
    }
  }

  get(key) {
    this._prune();
    const entry = this._store.get(key);
    if (!entry) return Promise.resolve(null);
    return Promise.resolve(entry.value);
  }

  put(key, value, { expirationTtl } = {}) {
    const expiresAt = expirationTtl
      ? Date.now() + expirationTtl * 1000
      : null;
    this._store.set(key, { value: String(value), expiresAt });
    return Promise.resolve();
  }

  delete(key) {
    this._store.delete(key);
    return Promise.resolve();
  }

  list({ prefix = "" } = {}) {
    this._prune();
    const keys = [];
    for (const [k] of this._store.entries()) {
      if (k.startsWith(prefix)) keys.push({ name: k });
    }
    return Promise.resolve({ keys, list_complete: true });
  }
}

const _namespaces = {};

export function getKVNamespace(name) {
  if (!_namespaces[name]) {
    _namespaces[name] = new KVNamespace(name);
  }
  return _namespaces[name];
}
