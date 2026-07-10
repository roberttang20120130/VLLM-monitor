"use strict";

// Electron main process: owns the window, the persisted server list, and one
// polling loop per enabled server. Each loop fetches /get_server_info +
// /metrics, computes tokens/sec from the token counters, builds a snapshot,
// pushes it to the renderer, and appends it to a per-server history ring
// buffer (for the chart). Loops are created/destroyed as servers are
// added/removed/toggled.

const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const { createStore } = require("./store");
const { normalizeBaseUrl, fetchJson, fetchText } = require("./vllm-client");
const {
  parsePrometheusText,
  sumMetric,
  firstMetric,
  firstMetricAny,
  histogramMean,
  histogramMeanAny,
  CounterRate,
  queueCountFromInfo,
} = require("./metrics");
const { detectJam } = require("./jamDetector");

// Disable the OS-level setuid sandbox at the process level.
//
// Electron bundles a `chrome-sandbox` helper and, by default, launches its
// zygote with the setuid sandbox. The rule Chromium enforces is strict: if that
// helper binary is PRESENT but not owned by root with mode 4755, the process
// ABORTS ("The SUID sandbox helper binary was found, but is not configured
// correctly...") rather than falling back to no sandbox.
//
// That always bites packaged distributions:
//   - AppImage: mounts read-only as the current user, so chrome-sandbox can
//     never be SUID inside /tmp/.mount_... -> aborts on double-click.
//   - .deb: the postinstall normally chmod 4755's the helper, but only if the
//     package is installed via dpkg/apt as root; a manual extract won't, and
//     some sandboxed/home dirs block SUID entirely.
//
// We already set sandbox:false on each BrowserWindow's webPreferences (which
// disables the *renderer* sandbox), but that does NOT stop the zygote-level
// setuid sandbox from being attempted at startup. Appending --no-sandbox here
// bakes the opt-out into the app so it launches by double-click with no flags.
//
// Security is still preserved for our use case: contextIsolation:true +
// nodeIntegration:false mean the renderer (which only loads our local
// index.html/renderer.js) has no Node access, and the only bridge to the main
// process is the narrow, allowlisted preload contextBridge API. The app makes
// outbound HTTP only to the vLLM URLs the user explicitly enters.
app.commandLine.appendSwitch("no-sandbox");

const HISTORY_LIMIT = 180; // ~6 minutes at 2s polling

/** @type {BrowserWindow|null} */
let mainWindow = null;

// per-server live state, keyed by server id
const loops = new Map();

/**
 * @typedef {Object} ServerState
 * @property {number} timer            setInterval id
 * @property {CounterRate} genRate     generation tokens counter rate
 * @property {CounterRate} promptRate  prompt tokens counter rate
 * @property {{t:number, genTokS:number, promptTokS:number, running:number|null, waiting:number|null}[]} history
 * @property {Object|null} lastSnap    most recent snapshot (for getSnapshot)
 */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0e1117",
    title: "vLLM Monitor",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: false so the packaged app does NOT depend on the chrome-sandbox
      // helper having the SUID bit + root ownership. With sandbox:true, clicking
      // the installed .deb / AppImage in a file manager fails silently (the
      // sandbox helper can't initialize without SUID, and there's no terminal to
      // print the error). contextIsolation:true + nodeIntegration:false still
      // keep the renderer isolated from Node APIs; the only surface exposed is
      // the narrow preload contextBridge API.
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const store = createStore(app, safeStorage);

  // send the current server list to the renderer whenever it changes
  function broadcastServers() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("servers:changed", store.list());
    }
  }

  // ----- IPC: server CRUD -----
  ipcMain.handle("servers:list", () => store.list());
  ipcMain.handle("servers:add", (_evt, server) => {
    const created = store.add(server);
    startLoop(created);
    broadcastServers();
    return created;
  });
  ipcMain.handle("servers:update", (_evt, id, patch) => {
    const updated = store.update(id, patch);
    if (updated) {
      // restart the loop to pick up new url/key/interval
      stopLoop(id);
      startLoop(updated);
      broadcastServers();
    }
    return updated;
  });
  ipcMain.handle("servers:remove", (_evt, id) => {
    stopLoop(id);
    const ok = store.remove(id);
    broadcastServers();
    return ok;
  });
  ipcMain.handle("servers:encryption-status", () => store.encryptionStatus());

  // ----- IPC: live data -----
  ipcMain.handle("metrics:snapshot", (_evt, id) => {
    if (id) {
      const st = loops.get(id);
      return st ? st.lastSnap : null;
    }
    // all
    const all = {};
    for (const [sid, st] of loops) all[sid] = st.lastSnap;
    return all;
  });
  ipcMain.handle("metrics:history", (_evt, id) => {
    const st = loops.get(id);
    return st ? st.history.slice() : [];
  });

  createWindow();

  // start a loop for each persisted server (enter-once: servers survive restart)
  for (const srv of store.list()) {
    startLoop(srv);
  }
  // push the initial list once the window is ready
  mainWindow.webContents.once("did-finish-load", () => {
    broadcastServers();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // stop all loops
  for (const id of loops.keys()) stopLoop(id);
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// Per-server polling
// ---------------------------------------------------------------------------

/**
 * Start (or restart) the polling loop for a server.
 * @param {import("./store").StoredServer} srv
 */
function startLoop(srv) {
  stopLoop(srv.id);
  if (!srv.enabled) return;

  const vllmUrl = normalizeBaseUrl(srv.vllmUrl);
  if (!vllmUrl) return;
  const metricsUrl = normalizeBaseUrl(srv.metricsUrl) || vllmUrl;

  /** @type {ServerState} */
  const state = {
    timer: null,
    genRate: new CounterRate(),
    promptRate: new CounterRate(),
    history: [],
    lastSnap: null,
  };
  loops.set(srv.id, state);

  const intervalMs = Math.max(500, (srv.pollInterval || 2) * 1000);

  const tick = async () => {
    const now = Date.now();
    const snap = await pollOnce(srv, vllmUrl, metricsUrl, state, now);
    state.lastSnap = snap;
    state.history.push({
      t: now,
      genTokS: snap.genTokS,
      promptTokS: snap.promptTokS,
      running: snap.running,
      waiting: snap.waiting,
    });
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    // Jam detection: analyze the history buffer for congestion patterns.
    snap.jam = detectJam(state.history);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("metrics:update", snap);
    }
  };

  // fire immediately, then on interval
  tick();
  state.timer = setInterval(tick, intervalMs);
}

/** @param {string} id */
function stopLoop(id) {
  const st = loops.get(id);
  if (!st) return;
  if (st.timer) clearInterval(st.timer);
  loops.delete(id);
}

/**
 * Fetch both endpoints for a server and build a normalized snapshot.
 * Never throws: on any error returns a snapshot with connection:"error".
 *
 * @param {import("./store").StoredServer} srv
 * @param {string} vllmUrl
 * @param {string} metricsUrl
 * @param {ServerState} state
 * @param {number} nowMs
 */
async function pollOnce(srv, vllmUrl, metricsUrl, state, nowMs) {
  const snap = {
    serverId: srv.id,
    serverName: srv.name,
    t: nowMs,
    connection: "ok",
    error: null,
    // throughput
    genTokS: null,
    promptTokS: null,
    avgGenTokS: null, // vLLM's own reported avg (cross-check)
    avgPromptTokS: null,
    // queue
    running: null,
    waiting: null,
    swapped: null,
    // misc
    gpuCache: null,
    ttft: null, // seconds, histogram mean
    tpot: null, // seconds, histogram mean (time per output token)
    vllmVersion: null,
  };

  // Fetch /metrics + /get_server_info. Some vLLM versions nest the info
  // endpoint under /v1 (e.g. http://host:8000/v1/get_server_info returns 401,
  // while /get_server_info at the root is 404), so try both paths: root first,
  // then /v1. We don't know which exists without trying.
  const metricsPromise = fetchText(metricsUrl, "/metrics", srv.apiKey);
  let infoRes = await fetchJson(vllmUrl, "/get_server_info", srv.apiKey);
  if (!infoRes.ok && infoRes.status === 404) {
    // root path doesn't exist on this vLLM version; try the /v1 prefix
    infoRes = await fetchJson(vllmUrl, "/v1/get_server_info", srv.apiKey);
  }
  const metricsRes = await metricsPromise;

  // If BOTH failed, report the (most informative) error.
  if (!infoRes.ok && !metricsRes.ok) {
    snap.connection = "error";
    snap.error = infoRes.authError
      ? infoRes.error
      : metricsRes.authError
      ? metricsRes.error
      : infoRes.error || metricsRes.error;
    return snap;
  }

  // /get_server_info: queue counts + vLLM-reported throughput + version
  if (infoRes.ok && infoRes.data) {
    const info = infoRes.data;
    snap.vllmVersion = info.version || info.vllm_version || null;
    snap.running = queueCountFromInfo(info, "running");
    snap.waiting = queueCountFromInfo(info, "waiting");
    snap.swapped = queueCountFromInfo(info, "swapped");
    // vLLM reports avg throughput (tok/s) in some versions
    snap.avgGenTokS = typeof info.avg_generation_throughput === "number" ? info.avg_generation_throughput : null;
    snap.avgPromptTokS = typeof info.avg_prompt_throughput === "number" ? info.avg_prompt_throughput : null;
  } else if (infoRes.authError) {
    snap.connection = "error";
    snap.error = infoRes.error;
    return snap;
  }

  // /metrics: parse + compute tok/s from counters
  if (metricsRes.ok && metricsRes.text) {
    const m = parsePrometheusText(metricsRes.text);

    // counters -> live tok/s
    const genTotal = sumMetric(m, "vllm:generation_tokens_total");
    const promptTotal = sumMetric(m, "vllm:prompt_tokens_total");
    if (genTotal != null) snap.genTokS = round(state.genRate.rate(genTotal, nowMs), 1);
    if (promptTotal != null) snap.promptTokS = round(state.promptRate.rate(promptTotal, nowMs), 1);

    // gauges: fall back for queue counts if /get_server_info didn't provide them
    if (snap.running == null) snap.running = firstMetric(m, "vllm:num_requests_running");
    if (snap.waiting == null) snap.waiting = firstMetric(m, "vllm:num_requests_waiting");
    // Swapped/preempted: newer vLLM versions replaced the num_requests_swapped
    // gauge with a num_preemptions_total counter. Fall back across both names.
    if (snap.swapped == null) snap.swapped = firstMetricAny(m, [
      "vllm:num_requests_swapped",
      "vllm:num_preemptions_total",
    ]);

    // GPU/KV cache usage: name changed across vLLM versions
    //   older: vllm:gpu_cache_usage_perc   newer: vllm:kv_cache_usage_perc
    snap.gpuCache = firstMetricAny(m, [
      "vllm:gpu_cache_usage_perc",
      "vllm:kv_cache_usage_perc",
    ]);
    snap.ttft = histogramMean(m, "vllm:time_to_first_token_seconds");
    // Time-per-output-token: name changed across vLLM versions
    //   older: vllm:time_per_output_token_seconds
    //   newer: vllm:request_time_per_output_token_seconds
    snap.tpot = histogramMeanAny(m, [
      "vllm:time_per_output_token_seconds",
      "vllm:request_time_per_output_token_seconds",
    ]);
  } else if (metricsRes.authError) {
    snap.connection = "error";
    snap.error = metricsRes.error;
    return snap;
  }

  // If one endpoint failed but the other didn't, we still have partial data;
  // mark a soft warning but keep connection "ok" so the user sees the data.
  if (!infoRes.ok && metricsRes.ok) {
    snap.error = "get_server_info: " + infoRes.error;
  } else if (infoRes.ok && !metricsRes.ok) {
    snap.error = "metrics: " + metricsRes.error;
  }

  return snap;
}

/** @param {number} n @param {number} d */
function round(n, d) {
  if (n == null || Number.isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
