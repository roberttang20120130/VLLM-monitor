"use strict";

// Prometheus text-format parser + vLLM-specific metric extraction.
//
// vLLM exposes a Prometheus `/metrics` endpoint. The text format is:
//   # HELP <name> <text>
//   # TYPE <name> <counter|gauge|histogram|summary>
//   <name>{<labels>} <value> [<timestamp>]
//   <name> <value>                      (no labels)
//
// For histograms, vLLM emits:
//   <name>_bucket{le="0.1"} N
//   ...
//   <name>_bucket{le="+Inf"} N
//   <name>_sum S
//   <name>_count C
//
// We keep this parser deliberately small and defensive: any line we can't
// parse is skipped (never thrown), and any metric we expect but don't find
// yields `null` downstream. This keeps the dashboard sane across vLLM
// versions where metric names occasionally change.

/**
 * Parse Prometheus exposition text into a map of metric name -> samples.
 *
 * Each entry is an array of { labels: {...}, value: Number } samples, summed
 * is NOT done here (callers decide whether to sum or pick). Lines that fail to
 * parse are silently dropped.
 *
 * @param {string} text
 * @returns {Map<string, Array<{labels: Object<string,string>, value: number}>>}
 */
function parsePrometheusText(text) {
  const out = new Map();
  if (typeof text !== "string" || text.length === 0) return out;

  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    // Split into "name{labels}" and "value" on the first whitespace that is
    // outside any {...}. Prometheus also accepts a trailing timestamp token;
    // we ignore anything after the value.
    let i = 0;
    let inBraces = false;
    let splitAt = -1;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "{") inBraces = true;
      else if (ch === "}") inBraces = false;
      else if (ch === " " || ch === "\t") {
        if (!inBraces) {
          splitAt = i;
          break;
        }
      }
      i++;
    }
    if (splitAt === -1) continue;

    const nameLabelsPart = line.slice(0, splitAt);
    const rest = line.slice(splitAt).trim();
    // value is the first token of `rest` (timestamp may follow)
    const valueTok = rest.split(/\s+/)[0];
    const value = parseFloat(valueTok);
    if (Number.isNaN(value)) continue;

    // Split name and {labels}
    let name = nameLabelsPart;
    let labels = {};
    const braceStart = nameLabelsPart.indexOf("{");
    const braceEnd = nameLabelsPart.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
      name = nameLabelsPart.slice(0, braceStart);
      const labelStr = nameLabelsPart.slice(braceStart + 1, braceEnd);
      labels = parseLabels(labelStr);
    }

    if (!out.has(name)) out.set(name, []);
    out.get(name).push({ labels, value });
  }
  return out;
}

/**
 * Parse a Prometheus label string like `model="qwen",le="0.1"` into an object.
 * Handles escaped quotes (\") inside values.
 * @param {string} s
 * @returns {Object<string,string>}
 */
function parseLabels(s) {
  const labels = {};
  let i = 0;
  while (i < s.length) {
    // skip whitespace/commas
    while (i < s.length && (s[i] === " " || s[i] === ",")) i++;
    if (i >= s.length) break;
    // read key
    let key = "";
    while (i < s.length && s[i] !== "=") {
      key += s[i];
      i++;
    }
    if (i >= s.length || s[i] !== "=") break;
    i++; // skip '='
    if (i >= s.length || s[i] !== '"') break;
    i++; // skip opening quote
    let val = "";
    while (i < s.length) {
      if (s[i] === "\\" && i + 1 < s.length) {
        // escaped char
        val += s[i + 1];
        i += 2;
        continue;
      }
      if (s[i] === '"') break;
      val += s[i];
      i++;
    }
    if (i < s.length && s[i] === '"') i++; // skip closing quote
    labels[key.trim()] = val;
  }
  return labels;
}

/**
 * Sum the values of all samples for a metric name (ignoring labels).
 * Returns null if the metric is absent.
 * @param {Map} map
 * @param {string} name
 * @returns {number|null}
 */
function sumMetric(map, name) {
  if (!map.has(name)) return null;
  const samples = map.get(name);
  let total = 0;
  for (const s of samples) total += s.value;
  return total;
}

/**
 * Pick the value of a single-sample metric (first sample). Returns null if absent.
 * @param {Map} map
 * @param {string} name
 * @returns {number|null}
 */
function firstMetric(map, name) {
  if (!map.has(name)) return null;
  return map.get(name)[0].value;
}

/**
 * Compute the mean of a histogram from its _sum and _count samples.
 * Returns null if either is absent or count is 0.
 * @param {Map} map
 * @param {string} baseName  e.g. "vllm:time_per_output_token_seconds"
 * @returns {number|null}
 */
function histogramMean(map, baseName) {
  const sum = sumMetric(map, baseName + "_sum");
  const count = sumMetric(map, baseName + "_count");
  if (sum == null || count == null) return null;
  if (count === 0) return null;
  return sum / count;
}

/**
 * A stateful per-server rate computer for monotonic counters.
 *
 * Tokens/sec = delta(counter) / delta(time) between successive polls.
 * Guards against counter resets (server restart: counter drops) by returning 0
 * and resetting the baseline, so a restart never produces a negative/insane rate.
 */
class CounterRate {
  constructor() {
    /** @type {number|null} */
    this._prevValue = null;
    /** @type {number|null} ms epoch */
    this._prevTime = null;
  }

  /**
   * Feed the latest counter value + timestamp, return the per-second rate.
   * @param {number} value
   * @param {number} nowMs
   * @returns {number} tokens per second (0 on first sample or reset)
   */
  rate(value, nowMs) {
    if (this._prevValue == null || this._prevTime == null) {
      this._prevValue = value;
      this._prevTime = nowMs;
      return 0;
    }
    const dt = (nowMs - this._prevTime) / 1000;
    if (dt <= 0) {
      // no time elapsed (clock jitter); keep baseline, report 0
      this._prevValue = value;
      this._prevTime = nowMs;
      return 0;
    }
    let delta = value - this._prevValue;
    if (delta < 0) {
      // counter reset (server restart): re-baseline, report 0
      this._prevValue = value;
      this._prevTime = nowMs;
      return 0;
    }
    this._prevValue = value;
    this._prevTime = nowMs;
    return delta / dt;
  }

  /** Reset baseline (e.g. when polling is stopped/restarted). */
  reset() {
    this._prevValue = null;
    this._prevTime = null;
  }
}

/**
 * Extract a queue count from the /get_server_info JSON. vLLM versions use
 * different field names/shapes; this handles the common variants:
 *   - numeric: { running: 3, waiting: 5 }
 *   - array:   { running_queue: [{...}], waiting_queue: [{...}] }
 *   - nested:  { num_requests_running: 3, num_requests_waiting: 5 }
 * Returns null if nothing recognizable is found.
 *
 * @param {object} info
 * @param {"running"|"waiting"|"swapped"} which
 * @returns {number|null}
 */
function queueCountFromInfo(info, which) {
  if (!info || typeof info !== "object") return null;
  const candidates = {
    running: ["running", "running_queue", "num_requests_running"],
    waiting: ["waiting", "waiting_queue", "num_requests_waiting"],
    swapped: ["swapped", "swapped_queue", "num_requests_swapped"],
  }[which] || [];

  for (const key of candidates) {
    if (key in info) {
      const v = info[key];
      if (typeof v === "number") return v;
      if (Array.isArray(v)) return v.length;
    }
  }
  return null;
}

/**
 * Return the value of the first single-sample metric found among `names`,
 * checking each in order. Useful for metrics vLLM renamed across versions
 * (e.g. gpu_cache_usage_perc -> kv_cache_usage_perc). Returns null if none.
 * @param {Map} map
 * @param {string[]} names
 * @returns {number|null}
 */
function firstMetricAny(map, names) {
  for (const n of names) {
    const v = firstMetric(map, n);
    if (v != null) return v;
  }
  return null;
}

/**
 * Return the histogram mean of the first base name (among `names`) that has
 * both _sum and _count samples. For vLLM version differences like
 * time_per_output_token_seconds vs request_time_per_output_token_seconds.
 * @param {Map} map
 * @param {string[]} baseNames
 * @returns {number|null}
 */
function histogramMeanAny(map, baseNames) {
  for (const b of baseNames) {
    const v = histogramMean(map, b);
    if (v != null) return v;
  }
  return null;
}

module.exports = {
  parsePrometheusText,
  parseLabels,
  sumMetric,
  firstMetric,
  firstMetricAny,
  histogramMean,
  histogramMeanAny,
  CounterRate,
  queueCountFromInfo,
};
