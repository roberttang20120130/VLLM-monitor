"use strict";

// Persistent, encrypted-at-rest storage for the server list.
//
// The server list lives at <userData>/servers.json. API keys are encrypted
// with Electron's safeStorage before writing (macOS Keychain, Windows DPAPI,
// Linux libsecret) and decrypted on read. This means the user enters each
// server's API key once and it survives restarts, without the key being
// recoverable from the file by another user/process on the machine.
//
// If safeStorage encryption is unavailable (e.g. headless Linux with no
// libsecret/GNOME keyring), we fall back to storing keys in plaintext but warn
// once on the console and via a flag the UI can read, so the user knows their
// keys are not encrypted. This keeps the app usable on minimal environments
// while being honest about the security tradeoff.
//
// The store is created lazily with the Electron app + safeStorage, so this
// module exports a factory (createStore) rather than a singleton: main.js
// constructs it after app.whenReady().

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * @typedef {Object} StoredServer
 * @property {string} id           stable unique id (random)
 * @property {string} name         display name
 * @property {string} vllmUrl      e.g. http://host:8000
 * @property {string} [metricsUrl] optional override; empty string = use vllmUrl
 * @property {string} apiKey       plaintext in memory only; encrypted on disk
 * @property {number} pollInterval seconds
 * @property {boolean} enabled     polling on/off
 */

/**
 * @param {Electron.App} app
 * @param {Electron.SafeStorage} safeStorage
 */
function createStore(app, safeStorage) {
  const userData = app.getPath("userData");
  const filePath = path.join(userData, "servers.json");

  let encryptionAvailable = false;
  let warnedPlaintext = false;
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    encryptionAvailable = false;
  }
  if (!encryptionAvailable) {
    console.warn(
      "[store] Electron safeStorage encryption is NOT available on this system. " +
        "API keys will be stored in PLAINTEXT in " + filePath + ". " +
        "On Linux, install/run a keyring (gnome-keyring/libsecret) to enable encryption."
    );
  }

  /** @type {StoredServer[]} */
  let servers = [];

  function load() {
    try {
      if (!fs.existsSync(filePath)) {
        servers = [];
        return;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        servers = [];
        return;
      }
      servers = parsed.map(decryptServer).filter(Boolean);
    } catch (err) {
      console.error("[store] Failed to load servers.json:", err.message);
      servers = [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const serializable = servers.map(encryptServer);
      fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), "utf8");
    } catch (err) {
      console.error("[store] Failed to write servers.json:", err.message);
    }
  }

  /** Decrypt the apiKey of one server record (or pass through plaintext). */
  function decryptServer(rec) {
    if (!rec || typeof rec !== "object") return null;
    let apiKey = "";
    if (typeof rec.apiKey === "string" && rec.apiKey !== "") {
      if (encryptionAvailable && rec._enc) {
        try {
          const buf = Buffer.from(rec.apiKey, "base64");
          apiKey = safeStorage.decryptString(buf);
        } catch {
          // maybe it was plaintext from before encryption, or corrupt
          apiKey = rec.apiKey;
        }
      } else {
        apiKey = rec.apiKey;
      }
    }
    return {
      id: rec.id || crypto.randomUUID(),
      name: rec.name || "vLLM server",
      vllmUrl: rec.vllmUrl || "",
      metricsUrl: rec.metricsUrl || "",
      apiKey,
      pollInterval: typeof rec.pollInterval === "number" ? rec.pollInterval : 2,
      enabled: rec.enabled !== false,
    };
  }

  /** Encrypt the apiKey of one server record for disk. */
  function encryptServer(srv) {
    const out = {
      id: srv.id,
      name: srv.name,
      vllmUrl: srv.vllmUrl,
      metricsUrl: srv.metricsUrl || "",
      pollInterval: srv.pollInterval,
      enabled: srv.enabled,
    };
    if (typeof srv.apiKey === "string" && srv.apiKey !== "") {
      if (encryptionAvailable) {
        const enc = safeStorage.encryptString(srv.apiKey);
        out.apiKey = enc.toString("base64");
        out._enc = true;
      } else {
        out.apiKey = srv.apiKey;
        out._enc = false;
        if (!warnedPlaintext) {
          warnedPlaintext = true;
        }
      }
    } else {
      out.apiKey = "";
      out._enc = false;
    }
    return out;
  }

  /** @returns {StoredServer[]} shallow copies (apiKey included) */
  function list() {
    return servers.map((s) => ({ ...s }));
  }

  /**
   * @param {Omit<StoredServer,"id">} input
   * @returns {StoredServer}
   */
  function add(input) {
    const srv = {
      id: crypto.randomUUID(),
      name: input.name || "vLLM server",
      vllmUrl: input.vllmUrl || "",
      metricsUrl: input.metricsUrl || "",
      apiKey: input.apiKey || "",
      pollInterval: typeof input.pollInterval === "number" ? input.pollInterval : 2,
      enabled: input.enabled !== false,
    };
    servers.push(srv);
    save();
    return { ...srv };
  }

  /**
   * @param {string} id
   * @param {Partial<StoredServer>} patch
   * @returns {StoredServer|null}
   */
  function update(id, patch) {
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const cur = servers[idx];
    const next = {
      ...cur,
      ...patch,
      id: cur.id, // id is immutable
    };
    servers[idx] = next;
    save();
    return { ...next };
  }

  /** @param {string} id @returns {boolean} */
  function remove(id) {
    const idx = servers.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    servers.splice(idx, 1);
    save();
    return true;
  }

  /** @param {string} id @returns {StoredServer|null} */
  function get(id) {
    const s = servers.find((s) => s.id === id);
    return s ? { ...s } : null;
  }

  function encryptionStatus() {
    return { encryptionAvailable, plaintextFallback: !encryptionAvailable };
  }

  load();

  return { list, add, update, remove, get, encryptionStatus, reload: load };
}

module.exports = { createStore };
