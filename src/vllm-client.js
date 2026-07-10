"use strict";

// HTTP client for a vLLM server. Two endpoints matter for monitoring:
//   GET {vllmUrl}/get_server_info   -> JSON (queue lengths, vLLM-reported throughput)
//   GET {metricsUrl}/metrics        -> Prometheus exposition text
//
// vLLM serves /metrics on the same port as the API server by default; some
// deployments use a separate --metrics-port, so metricsUrl is configurable and
// defaults to vllmUrl.
//
// Auth: vLLM's --api-key is checked via an `Authorization: Bearer <key>` header.
// We send the header whenever a key is configured; an empty key means an
// unauthenticated server (no header). A 401 is surfaced as an explicit
// "invalid API key" error so the UI can tell the user to fix it.
//
// Every call is wrapped so failures never throw to the caller: they resolve to
// an { ok:false, error } object instead. This keeps the polling loop alive
// even when a server is down, misconfigured, or on a flaky network.

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Validate + normalize a base URL (trim trailing slash).
 * @param {string} url
 * @returns {string|null} normalized URL, or null if invalid
 */
function normalizeBaseUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed === "") return null;
  try {
    const u = new URL(trimmed);
    // strip trailing slash(es) from the pathname for clean concatenation
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Fetch JSON from {baseUrl}{path}, sending Bearer auth if a key is set.
 * Never throws; returns { ok, status, data?, error? }.
 *
 * @param {string} baseUrl
 * @param {string} path        e.g. "/get_server_info"
 * @param {string} [apiKey]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean, status:number|null, data?:any, error?:string, authError?:boolean}>}
 */
async function fetchJson(baseUrl, path, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = baseUrl + path;
  const headers = {};
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = "Bearer " + apiKey.trim();
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: "Invalid or missing API key", authError: true };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: null, error: describeError(err) };
  }
}

/**
 * Fetch raw text (Prometheus exposition) from {baseUrl}{path}.
 * Never throws; returns { ok, status, text?, error? }.
 *
 * @param {string} baseUrl
 * @param {string} path        e.g. "/metrics"
 * @param {string} [apiKey]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean, status:number|null, text?:string, error?:string, authError?:boolean}>}
 */
async function fetchText(baseUrl, path, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = baseUrl + path;
  const headers = {};
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = "Bearer " + apiKey.trim();
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: "Invalid or missing API key", authError: true };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: null, error: describeError(err) };
  }
}

/**
 * Turn an Error (especially fetch/Abort errors) into a short human string.
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err && err.name === "AbortError") return "Request timed out";
  if (err && err.cause && err.cause.code) {
    // Node fetch wraps connection errors with a `cause` having a code
    const code = err.cause.code;
    if (code === "ECONNREFUSED") return "Connection refused (server not running?)";
    if (code === "ENOTFOUND") return "Host not found";
    if (code === "ECONNRESET") return "Connection reset";
    if (code === "EAI_AGAIN") return "DNS lookup failed";
  }
  if (err && err.message) return err.message;
  return "Network error";
}

module.exports = {
  normalizeBaseUrl,
  fetchJson,
  fetchText,
  DEFAULT_TIMEOUT_MS,
};
