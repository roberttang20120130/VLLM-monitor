"use strict";

// Preload: bridges the sandboxed renderer to the main process over IPC, but
// only exposes a narrow, explicitly-allowlisted API via contextBridge. The
// renderer never gets direct access to Node/Electron or to arbitrary IPC
// channels -- it can only call these functions and listen for these events.
//
// API keys are returned by listServers/getServers because the renderer needs
// them to pre-fill the edit form; they never leave the local machine and are
// already decrypted in the main process. (If you want to hide them from the
// DOM entirely, drop the apiKey field here -- but editing requires it.)

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // --- server CRUD ---
  listServers: () => ipcRenderer.invoke("servers:list"),
  addServer: (server) => ipcRenderer.invoke("servers:add", server),
  updateServer: (id, patch) => ipcRenderer.invoke("servers:update", id, patch),
  removeServer: (id) => ipcRenderer.invoke("servers:remove", id),
  encryptionStatus: () => ipcRenderer.invoke("servers:encryption-status"),

  // --- live data ---
  // Snapshot for one server (or all if id omitted): latest metrics + status.
  getSnapshot: (id) => ipcRenderer.invoke("metrics:snapshot", id),
  // History array of ~180 samples for one server (for the chart).
  getHistory: (id) => ipcRenderer.invoke("metrics:history", id),

  // --- events (main -> renderer) ---
  // Fired whenever any server's snapshot updates. Callback gets (snapshot).
  onUpdate: (callback) => {
    const handler = (_evt, snapshot) => callback(snapshot);
    ipcRenderer.on("metrics:update", handler);
    // return an unsubscribe function
    return () => ipcRenderer.removeListener("metrics:update", handler);
  },
  // Fired when the server list changes (add/remove/edit/toggle).
  onServersChanged: (callback) => {
    const handler = (_evt, servers) => callback(servers);
    ipcRenderer.on("servers:changed", handler);
    return () => ipcRenderer.removeListener("servers:changed", handler);
  },
});
