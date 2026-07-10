"use strict";

// Mock vLLM server for development/verification. Spins up two fake vLLM HTTP
// servers on different ports (one requiring a Bearer API key, one open) that
// emit realistic /get_server_info JSON and /metrics Prometheus text with
// ever-increasing token counters and fluctuating queue sizes. This lets the
// dashboard be exercised end-to-end without a real GPU/vLLM instance.
//
// Run:  node mock/mock-vllm.js
// Then in the app, add servers:
//   http://localhost:9001        (no key)
//   http://localhost:9002        (key: test-secret-key)

const http = require("node:http");

const SERVERS = [
  { port: 9001, name: "mock-open",    apiKey: "" },
  { port: 9002, name: "mock-authed",  apiKey: "test-secret-key" },
];

// shared, ever-increasing counters per server
function makeState() {
  return {
    genTokens: 0,
    promptTokens: 0,
    genSum: 0, genCount: 0,      // histogram for time_per_output_token
    ttftSum: 0, ttftCount: 0,    // histogram for time_to_first_token
    startedAt: Date.now(),
  };
}
const states = new Map();
for (const s of SERVERS) states.set(s.port, makeState());

// advance counters on a timer so /metrics returns monotonically increasing
// counters (the dashboard computes tok/s = delta(counter)/delta(t)).
setInterval(() => {
  for (const s of SERVERS) {
    const st = states.get(s.port);
    const genRate = 800 + Math.random() * 600;   // tok/s this interval
    const promptRate = 1500 + Math.random() * 1200;
    st.genTokens += genRate;
    st.promptTokens += promptRate;
    st.genSum += genRate * 0.012;   // ~12ms/token
    st.genCount += genRate;
    st.ttftSum += 0.05 + Math.random() * 0.1;
    st.ttftCount += 1 + Math.floor(Math.random() * 3);
  }
}, 1000);

function queueCounts(port) {
  // fluctuate a bit so the chart looks alive
  const seed = (Date.now() / 2000) | 0;
  const r = (n) => Math.floor(Math.abs(Math.sin(seed + port + n) * 5));
  const running = 1 + (r(1) % 4);
  const waiting = r(2) % 6;
  const swapped = r(3) % 2;
  return { running, waiting, swapped };
}

function buildMetrics(port) {
  const st = states.get(port);
  const { running, waiting, swapped } = queueCounts(port);
  const gpuCache = 0.3 + (Math.sin(Date.now() / 5000) * 0.2 + 0.2);
  const lines = [
    "# HELP vllm:num_requests_running Number of requests currently running.",
    "# TYPE vllm:num_requests_running gauge",
    `vllm:num_requests_running{model="mock-model"} ${running}`,
    "# HELP vllm:num_requests_waiting Number of requests in the waiting queue.",
    "# TYPE vllm:num_requests_waiting gauge",
    `vllm:num_requests_waiting{model="mock-model"} ${waiting}`,
    "# HELP vllm:num_requests_swapped Number of requests swapped to CPU.",
    "# TYPE vllm:num_requests_swapped gauge",
    `vllm:num_requests_swapped{model="mock-model"} ${swapped}`,
    "# HELP vllm:gpu_cache_usage_perc GPU KV cache usage percentage.",
    "# TYPE vllm:gpu_cache_usage_perc gauge",
    `vllm:gpu_cache_usage_perc ${gpuCache.toFixed(4)}`,
    "# HELP vllm:generation_tokens_total Number of generated tokens (counter).",
    "# TYPE vllm:generation_tokens_total counter",
    `vllm:generation_tokens_total{model="mock-model"} ${st.genTokens.toFixed(0)}`,
    "# HELP vllm:prompt_tokens_total Number of prompt tokens processed (counter).",
    "# TYPE vllm:prompt_tokens_total counter",
    `vllm:prompt_tokens_total{model="mock-model"} ${st.promptTokens.toFixed(0)}`,
    "# HELP vllm:time_per_output_token_seconds Histogram of time per output token.",
    "# TYPE vllm:time_per_output_token_seconds histogram",
    `vllm:time_per_output_token_seconds_bucket{le="0.01"} ${(st.genCount*0.1).toFixed(0)}`,
    `vllm:time_per_output_token_seconds_bucket{le="0.05"} ${(st.genCount*0.5).toFixed(0)}`,
    `vllm:time_per_output_token_seconds_bucket{le="+Inf"} ${st.genCount.toFixed(0)}`,
    `vllm:time_per_output_token_seconds_sum ${st.genSum.toFixed(2)}`,
    `vllm:time_per_output_token_seconds_count ${st.genCount.toFixed(0)}`,
    "# HELP vllm:time_to_first_token_seconds Histogram of time to first token.",
    "# TYPE vllm:time_to_first_token_seconds histogram",
    `vllm:time_to_first_token_seconds_bucket{le="0.05"} ${(st.ttftCount*0.3).toFixed(0)}`,
    `vllm:time_to_first_token_seconds_bucket{le="0.2"} ${(st.ttftCount*0.8).toFixed(0)}`,
    `vllm:time_to_first_token_seconds_bucket{le="+Inf"} ${st.ttftCount.toFixed(0)}`,
    `vllm:time_to_first_token_seconds_sum ${st.ttftSum.toFixed(2)}`,
    `vllm:time_to_first_token_seconds_count ${st.ttftCount.toFixed(0)}`,
    "",
  ];
  return lines.join("\n");
}

function buildServerInfo(port) {
  const st = states.get(port);
  const { running, waiting, swapped } = queueCounts(port);
  // mimic vLLM's /get_server_info shape (field names vary across versions;
  // the dashboard handles several variants, so we use the array form here)
  return JSON.stringify({
    version: "0.6.0.mock",
    model: "mock-model",
    running_queue: Array.from({ length: running }, (_, i) => ({ request_id: i })),
    waiting_queue: Array.from({ length: waiting }, (_, i) => ({ request_id: i })),
    swapped: swapped,
    avg_generation_throughput: Number((Math.random() * 1000 + 800).toFixed(1)),
    avg_prompt_throughput: Number((Math.random() * 1500 + 1500).toFixed(1)),
    uptime: Math.floor((Date.now() - st.startedAt) / 1000),
  });
}

function checkAuth(req, expectedKey) {
  if (!expectedKey) return true;
  const auth = req.headers["authorization"] || "";
  return auth === "Bearer " + expectedKey;
}

for (const s of SERVERS) {
  const server = http.createServer((req, res) => {
    if (!checkAuth(req, s.apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Invalid API key" }));
      return;
    }
    if (req.url === "/get_server_info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(buildServerInfo(s.port));
    } else if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(buildMetrics(s.port));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found" }));
    }
  });
  server.listen(s.port, () => {
    console.log(`[mock] ${s.name} on http://localhost:${s.port}` +
      (s.apiKey ? `  (API key: ${s.apiKey})` : "  (no auth)"));
  });
}

console.log("\nAdd these servers in the app:");
for (const s of SERVERS) {
  console.log(`  http://localhost:${s.port}` + (s.apiKey ? `  key: ${s.apiKey}` : "  (no key)"));
}
