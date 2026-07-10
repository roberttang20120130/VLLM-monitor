"use strict";

// Renderer: holds the client-side model of servers + the latest snapshot per
// server, renders the sidebar + detail panel, and draws the live chart on a
// canvas. Talks to the main process only through window.api (preload bridge).

/** @type {Array} server records from main */
let servers = [];
/** @type {Object<string, Object>} latest snapshot per server id */
const snapshots = {};
/** @type {string|null} selected server id */
let selectedId = null;
/** @type {string|null} id being edited in the modal (null = adding) */
let editingId = null;

// ---- DOM refs ----
const serverListEl = document.getElementById("server-list");
const detailNameEl = document.getElementById("detail-name");
const detailUrlEl = document.getElementById("detail-url");
const detailErrorEl = document.getElementById("detail-error");
const connDotEl = document.getElementById("conn-dot");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

// ---- boot ----
(async function init() {
  // encryption note
  const enc = await window.api.encryptionStatus();
  if (enc && enc.plaintextFallback) {
    document.getElementById("encryption-note").classList.remove("hidden");
  }

  servers = await window.api.listServers();
  renderSidebar();
  if (servers.length > 0) selectServer(servers[0].id);

  // live updates from main
  window.api.onUpdate((snap) => {
    if (!snap || !snap.serverId) return;
    snapshots[snap.serverId] = snap;
    updateSidebarRow(snap.serverId);
    if (snap.serverId === selectedId) renderDetail();
  });

  window.api.onServersChanged((list) => {
    servers = list;
    renderSidebar();
    if (selectedId && !servers.find((s) => s.id === selectedId)) {
      selectedId = servers.length ? servers[0].id : null;
      renderDetail();
    }
  });
})();

// ---- sidebar ----
function renderSidebar() {
  serverListEl.innerHTML = "";
  if (servers.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.style.padding = "24px 12px";
    li.textContent = "No servers yet. Click “+ Add server”.";
    serverListEl.appendChild(li);
    return;
  }
  for (const srv of servers) {
    serverListEl.appendChild(buildRow(srv));
  }
}

function buildRow(srv) {
  const li = document.createElement("li");
  li.className = "server-row" + (srv.id === selectedId ? " selected" : "");
  li.dataset.id = srv.id;

  const snap = snapshots[srv.id];
  const dotClass = snap
    ? snap.connection === "ok" ? "dot-ok" : "dot-error"
    : "dot-unknown";

  const gen = snap && snap.genTokS != null ? snap.genTokS.toFixed(1) : "—";
  const running = snap && snap.running != null ? snap.running : "—";
  const waiting = snap && snap.waiting != null ? snap.waiting : "—";

  // jam indicator: small colored dot, only shown on warning/jammed
  const jamStatus = snap && snap.jam ? snap.jam.status : null;
  const jamClass = (jamStatus === "warning" || jamStatus === "jammed")
    ? "jam-indicator " + jamStatus
    : "jam-indicator";

  li.innerHTML = `
    <span class="dot ${dotClass}"></span>
    <span class="${jamClass}" title="${jamStatus ? jamStatus : ""}"></span>
    <span class="name">${escapeHtml(srv.name)}</span>
    <span class="stats">
      <span class="gen">${gen} tok/s</span>
      <span>run ${running} · wait ${waiting}</span>
    </span>
    <span class="row-actions">
      <button title="Edit" data-act="edit">✎</button>
      <button title="${srv.enabled ? "Pause" : "Resume"}" data-act="toggle">${srv.enabled ? "⏸" : "▶"}</button>
      <button title="Remove" data-act="remove">✕</button>
    </span>
  `;

  li.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      e.stopPropagation();
      handleRowAction(btn.dataset.act, srv.id);
      return;
    }
    selectServer(srv.id);
  });

  return li;
}

function updateSidebarRow(id) {
  const srv = servers.find((s) => s.id === id);
  if (!srv) return;
  const old = serverListEl.querySelector(`.server-row[data-id="${cssEscape(id)}"]`);
  if (old) {
    const newRow = buildRow(srv);
    old.replaceWith(newRow);
  }
}

function handleRowAction(act, id) {
  if (act === "edit") {
    openModal(id);
  } else if (act === "remove") {
    if (confirm("Remove this server?")) window.api.removeServer(id);
  } else if (act === "toggle") {
    const srv = servers.find((s) => s.id === id);
    if (srv) window.api.updateServer(id, { enabled: !srv.enabled });
  }
}

// ---- detail panel ----
function selectServer(id) {
  selectedId = id;
  renderSidebar();
  renderDetail();
  drawChart();
  // prefetch history for the newly selected server
  window.api.getHistory(id).then((hist) => {
    if (id === selectedId) drawChart(hist);
  });
}

function renderDetail() {
  const jamBanner = document.getElementById("jam-banner");
  const jamStatusEl = document.getElementById("jam-status");
  const jamSignalsEl = document.getElementById("jam-signals");

  if (!selectedId) {
    detailNameEl.textContent = "No server selected";
    detailUrlEl.textContent = "";
    detailErrorEl.textContent = "";
    connDotEl.className = "dot dot-unknown";
    jamBanner.classList.add("hidden");
    clearCards();
    drawChart([]);
    return;
  }
  const srv = servers.find((s) => s.id === selectedId);
  if (!srv) return;
  const snap = snapshots[selectedId];

  detailNameEl.textContent = srv.name + (srv.enabled ? "" : " (paused)");
  detailUrlEl.textContent = srv.vllmUrl;
  detailErrorEl.textContent = snap && snap.error ? snap.error : "";

  if (!snap) {
    connDotEl.className = "dot dot-unknown";
  } else {
    connDotEl.className = "dot " + (snap.connection === "ok" ? "dot-ok" : "dot-error");
  }

  // jam banner
  if (snap && snap.jam && snap.connection === "ok") {
    const j = snap.jam;
    jamBanner.classList.remove("hidden");
    jamBanner.className = "jam-banner jam-" + j.status;
    jamStatusEl.textContent = j.message;
    jamSignalsEl.textContent = j.signals.length > 0 ? j.signals.join(" · ") : "";
  } else {
    jamBanner.classList.add("hidden");
  }

  setCard("genTokS", snap ? snap.genTokS : null, 1);
  setCard("promptTokS", snap ? snap.promptTokS : null, 1);
  setCard("running", snap ? snap.running : null);
  setCard("waiting", snap ? snap.waiting : null);
  setCard("swapped", snap ? snap.swapped : null);
  setCard("gpuCache", snap ? snap.gpuCache : null, null, true);
  setCard("ttft", snap ? snap.ttft : null, 3);
  setCard("tpot", snap ? snap.tpot : null, 3);

  drawChart();
}

function setCard(key, value, decimals, asPercent) {
  const el = document.getElementById("card-" + key);
  if (!el) return;
  if (value == null || Number.isNaN(value)) {
    el.textContent = "—";
    return;
  }
  if (asPercent) {
    el.textContent = (value * 100).toFixed(0) + "%";
  } else if (decimals != null) {
    el.textContent = value.toFixed(decimals);
  } else {
    el.textContent = String(value);
  }
}

function clearCards() {
  for (const key of ["genTokS","promptTokS","running","waiting","swapped","gpuCache","ttft","tpot"]) {
    const el = document.getElementById("card-" + key);
    if (el) el.textContent = "—";
  }
}

// ---- chart ----
// Draws two auto-scaled line series groups: tok/s (gen+prompt) and queue
// (running+waiting). Prefers live snapshots (which we append to as they
// arrive); if a history array is passed (from main), uses that instead.
let chartHistory = null; // when set, override for the selected server

async function drawChart(historyOverride) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // handle hidpi
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!selectedId) {
    drawEmptyChart(w, h, "Select a server");
    return;
  }

  let hist;
  if (historyOverride) {
    chartHistory = historyOverride;
    hist = historyOverride;
  } else if (chartHistory) {
    hist = chartHistory;
  } else {
    hist = await window.api.getHistory(selectedId);
    chartHistory = hist;
  }

  if (!hist || hist.length === 0) {
    drawEmptyChart(w, h, "Waiting for data…");
    return;
  }

  // pad left axis region
  const padL = 44, padR = 12, padT = 12, padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // two scales: tok/s (left) and queue (right). Each auto-scales to its own max.
  const tokMax = Math.max(1, ...hist.map((p) => Math.max(p.genTokS || 0, p.promptTokS || 0)));
  const qMax = Math.max(1, ...hist.map((p) => Math.max(p.running || 0, p.waiting || 0)));

  // grid + left axis (tok/s)
  ctx.strokeStyle = "#2a313c";
  ctx.fillStyle = "#8b949e";
  ctx.font = "10px sans-serif";
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    const tokVal = tokMax * (1 - i / gridLines);
    ctx.textAlign = "right";
    ctx.fillText(tokVal.toFixed(0), padL - 6, y + 3);
  }
  // right axis (queue)
  for (let i = 0; i <= gridLines; i++) {
    const qVal = qMax * (1 - i / gridLines);
    ctx.textAlign = "left";
    ctx.fillText(qVal.toFixed(0), w - padR + 3, padT + (plotH * i) / gridLines + 3);
  }

  // time axis: just label first/last
  ctx.textAlign = "center";
  ctx.fillStyle = "#8b949e";
  if (hist.length > 1) {
    ctx.fillText("-" + (((hist[hist.length-1].t - hist[0].t)/1000)|0) + "s", padL + 8, h - 6);
    ctx.fillText("now", w - padR - 12, h - 6);
  }

  const xFor = (i) => padL + (hist.length <= 1 ? plotW/2 : (plotW * i) / (hist.length - 1));
  const yTok = (v) => padT + plotH * (1 - (v || 0) / tokMax);
  const yQ = (v) => padT + plotH * (1 - (v || 0) / qMax);

  drawLine(hist, xFor, yTok, "genTokS", "#2f81f7");
  drawLine(hist, xFor, yTok, "promptTokS", "#a371f7");
  drawLine(hist, xFor, yQ, "running", "#3fb950");
  drawLine(hist, xFor, yQ, "waiting", "#d29922");

  // append latest live point if we're using main history and a newer snapshot exists
  if (!historyOverride) {
    const snap = snapshots[selectedId];
    if (snap) {
      chartHistory = null; // invalidate; will refetch next paint is fine
    }
  }
}

function drawLine(hist, xFor, yFor, field, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < hist.length; i++) {
    const v = hist[i][field];
    if (v == null) continue;
    const x = xFor(i);
    const y = yFor(v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawEmptyChart(w, h, msg) {
  ctx.fillStyle = "#8b949e";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, w / 2, h / 2);
}

// redraw chart on window resize
window.addEventListener("resize", () => { chartHistory = null; drawChart(); });

// ---- modal ----
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const form = document.getElementById("server-form");
document.getElementById("add-btn").addEventListener("click", () => openModal(null));
document.getElementById("modal-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

function openModal(id) {
  editingId = id;
  form.reset();
  if (id) {
    const srv = servers.find((s) => s.id === id);
    if (!srv) return;
    modalTitle.textContent = "Edit server";
    form.name.value = srv.name;
    form.vllmUrl.value = srv.vllmUrl;
    form.metricsUrl.value = srv.metricsUrl || "";
    form.apiKey.value = srv.apiKey || "";
    form.pollInterval.value = srv.pollInterval;
  } else {
    modalTitle.textContent = "Add vLLM server";
    form.pollInterval.value = 2;
  }
  modal.classList.remove("hidden");
  form.name.focus();
}

function closeModal() {
  modal.classList.add("hidden");
  editingId = null;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {
    name: form.name.value.trim() || "vLLM server",
    vllmUrl: form.vllmUrl.value.trim(),
    metricsUrl: form.metricsUrl.value.trim(),
    apiKey: form.apiKey.value,
    pollInterval: parseInt(form.pollInterval.value, 10) || 2,
    enabled: true,
  };
  // basic URL validation
  try { new URL(data.vllmUrl); } catch { alert("vLLM server URL is not a valid URL."); return; }

  if (editingId) {
    await window.api.updateServer(editingId, data);
  } else {
    await window.api.addServer(data);
  }
  closeModal();
});

// ---- helpers ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
