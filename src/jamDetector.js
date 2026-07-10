"use strict";

// Jam detector: analyzes a server's recent history to detect congestion.
//
// A "jam" is when the server is receiving a lot of work (prompt tokens
// spiking) but producing little output (generation tok/s dropping well below
// its own recent average), often accompanied by a growing waiting queue.
// This is the classic vLLM congestion pattern: heavy prefill load arrives,
// generation throughput collapses as the engine struggles to catch up, and
// requests pile up in the waiting queue.
//
// The detector is a pure function of the history buffer — no side effects, no
// I/O — so it's trivially testable. It compares the most recent few samples
// against a rolling median baseline of the server's own "usual" behavior, so
// it adapts to whatever the normal throughput is for that particular server
// (a small GPU box jamming at 50 tok/s looks the same as a big one jamming
// at 500 tok/s).
//
// Signals:
//   throughput_drop — recent gen tok/s is <50% of the baseline median
//   prompt_spike    — recent prompt tok/s is >200% of the baseline median
//   queue_buildup   — waiting queue is high (>3) and trending upward
//
// Status:
//   warming_up — not enough history yet to establish a baseline (<15 samples)
//   clear      — no congestion signals
//   warning    — one signal present (possible congestion)
//   jammed     — throughput_drop combined with prompt_spike and/or queue_buildup

// Number of recent samples to average for "current" behavior.
const RECENT_WINDOW = 5;
// Number of samples (excluding the recent window) used to compute the baseline.
const BASELINE_WINDOW = 50;
// Minimum samples before we'll make any judgment (avoids false positives on a
// freshly-added server where the first tok/s reading is always 0).
const MIN_SAMPLES = 15;

// Thresholds (multipliers of the baseline median):
const THROUGHPUT_DROP_RATIO = 0.5; // current < 50% of usual => drop
const PROMPT_SPIKE_RATIO = 2.0; // current > 200% of usual => spike
const QUEUE_HIGH_THRESHOLD = 3; // waiting above this counts as "high"
const QUEUE_TREND_WINDOW = 5; // compare recent waiting to this many samples ago
// For the "stalled under load" signal: this many running requests with
// near-zero generation means the engine is stuck (all requests stalled in
// prefill or long-context decode, none producing output).
const STALL_RUNNING_THRESHOLD = 3; // >= this many running requests
const STALL_GEN_THRESHOLD = 5; // <= this many tok/s = "near zero"

/**
 * Compute the median of an array of numbers. Returns null for empty input.
 * @param {number[]} arr
 * @returns {number|null}
 */
function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Average of an array of numbers, ignoring nulls. Returns null if all null.
 * @param {(number|null)[]} arr
 * @returns {number|null}
 */
function avgNonNull(arr) {
  const vals = arr.filter((v) => v != null && !Number.isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Analyze a server's history and return a jam status.
 *
 * @param {Array<{t:number, genTokS:number|null, promptTokS:number|null, running:number|null, waiting:number|null}>} history
 * @returns {{status:"warming_up"|"clear"|"warning"|"jammed", signals:string[], message:string}}
 */
function detectJam(history) {
  if (!Array.isArray(history) || history.length < MIN_SAMPLES) {
    return { status: "warming_up", signals: [], message: "Collecting baseline data…" };
  }

  // Split: recent (last RECENT_WINDOW samples) vs baseline (the
  // BASELINE_WINDOW samples before the recent window). This ensures the
  // baseline doesn't include the current anomaly we're trying to detect.
  const recent = history.slice(-RECENT_WINDOW);
  const baselineSlice = history.slice(
    -(RECENT_WINDOW + BASELINE_WINDOW),
    -RECENT_WINDOW
  );
  if (baselineSlice.length < MIN_SAMPLES) {
    return { status: "warming_up", signals: [], message: "Collecting baseline data…" };
  }

  const baselineGen = median(
    baselineSlice.map((s) => s.genTokS).filter((v) => v != null)
  );
  const baselinePrompt = median(
    baselineSlice.map((s) => s.promptTokS).filter((v) => v != null)
  );

  const recentGen = avgNonNull(recent.map((s) => s.genTokS));
  const recentPrompt = avgNonNull(recent.map((s) => s.promptTokS));

  const signals = [];

  // --- Signal 1: throughput drop ---
  // Only flag if the server normally produces something (baseline > 0).
  // A server that's idle (gen=0, prompt=0) is NOT jammed — a jam means there's
  // incoming work the server can't keep up with, so suppress the drop signal
  // when prompt rate has also fallen well below its baseline (i.e. no work
  // coming in). Idle = low gen AND low prompt; jammed = low gen AND high prompt.
  let throughputDrop = false;
  if (baselineGen != null && baselineGen > 0 && recentGen != null) {
    const isIdle =
      baselinePrompt != null &&
      baselinePrompt > 0 &&
      recentPrompt != null &&
      recentPrompt < baselinePrompt * THROUGHPUT_DROP_RATIO; // prompt also dropped
    if (recentGen < baselineGen * THROUGHPUT_DROP_RATIO && !isIdle) {
      throughputDrop = true;
      signals.push(
        `Generation throughput dropped to ${recentGen.toFixed(0)} tok/s ` +
          `(usual ~${baselineGen.toFixed(0)} tok/s)`
      );
    }
  }

  // --- Signal 2: prompt spike ---
  // Lots of new prefill work arriving. Only meaningful if there's actually
  // incoming traffic (recent prompt > 0).
  let promptSpike = false;
  if (baselinePrompt != null && baselinePrompt > 0 && recentPrompt != null) {
    if (recentPrompt > baselinePrompt * PROMPT_SPIKE_RATIO) {
      promptSpike = true;
      signals.push(
        `Prompt token rate spiked to ${recentPrompt.toFixed(0)} tok/s ` +
          `(usual ~${baselinePrompt.toFixed(0)} tok/s)`
      );
    }
  }

  // --- Signal 3: queue buildup ---
  // Waiting queue is high AND trending upward over the last few samples.
  let queueBuildup = false;
  const recentWaiting = recent.map((s) => s.waiting).filter((v) => v != null);
  if (recentWaiting.length > 0) {
    const currentWaiting = recentWaiting[recentWaiting.length - 1];
    const recentAvgWaiting =
      recentWaiting.reduce((a, b) => a + b, 0) / recentWaiting.length;

    // compare to the waiting from QUEUE_TREND_WINDOW samples ago
    const trendIdx = history.length - 1 - QUEUE_TREND_WINDOW;
    const trendWaiting = trendIdx >= 0 ? history[trendIdx].waiting : null;

    const isHigh = currentWaiting > QUEUE_HIGH_THRESHOLD;
    const isRising =
      trendWaiting != null && recentAvgWaiting > trendWaiting;

    if (isHigh && isRising) {
      queueBuildup = true;
      signals.push(
        `Waiting queue growing (${currentWaiting} requests, was ${trendWaiting})`
      );
    }
  }

  // --- Signal 4: stalled under load ---
  // Many requests are running but generation is near zero. This means the
  // engine has accepted work (high running count) but is producing little or
  // no output — all requests stalled in prefill or stuck on long contexts.
  // This is an absolute condition (no baseline needed): if >= STALL_RUNNING
  // requests are running and gen tok/s is <= STALL_GEN_THRESHOLD, the engine
  // is effectively stuck regardless of what "usual" looks like.
  let stalledUnderLoad = false;
  const recentRunning = recent.map((s) => s.running).filter((v) => v != null);
  if (recentRunning.length > 0 && recentGen != null) {
    const currentRunning = recentRunning[recentRunning.length - 1];
    if (currentRunning >= STALL_RUNNING_THRESHOLD && recentGen <= STALL_GEN_THRESHOLD) {
      stalledUnderLoad = true;
      signals.push(
        `${currentRunning} requests running but only ${recentGen.toFixed(0)} tok/s — engine stalled`
      );
    }
  }

  // --- Combine signals into a status ---
  // A full jam = throughput drop + (prompt spike or queue buildup),
  //   OR stalled under load (high running count + near-zero gen).
  // Both signatures mean: output is low while the engine has work it can't
  // process efficiently.
  if ((throughputDrop && (promptSpike || queueBuildup)) || stalledUnderLoad) {
    return {
      status: "jammed",
      signals,
      message: "Server appears jammed — throughput is low while load is high",
    };
  }

  // Any single signal = warning (possible congestion developing).
  if (signals.length > 0) {
    return { status: "warning", signals, message: "Possible congestion detected" };
  }

  return { status: "clear", signals: [], message: "Operating normally" };
}

module.exports = { detectJam, median, avgNonNull };
