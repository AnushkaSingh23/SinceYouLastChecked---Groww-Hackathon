// Volume-anomaly detection, live-only — no historical average-volume
// dependency (same philosophy as volatility.ts: we don't guess at data we
// don't have; we wait until we've observed enough this session to say
// something with confidence, and say plainly when we haven't yet).
//
// Yahoo's `regularMarketVolume` is cumulative shares traded so far *today*,
// not a per-tick count, so we track the delta between consecutive polls
// (shares traded in that ~20s window) and compare the latest delta against
// this symbol's own rolling baseline delta.

const MIN_DELTAS_FOR_LIVE = 8;

/**
 * Two thresholds, not one. "A bit busier than usual" and "something is
 * happening right now" are genuinely different messages, and the tier system
 * should be able to tell them apart rather than collapsing both into a single
 * boolean. scoring.ts weights them differently: ELEVATED is one signal,
 * SURGE is strong enough on its own to carry a symbol to CRITICAL.
 */
export const VOLUME_ELEVATED_RATIO = 1.5;
export const VOLUME_SURGE_RATIO = 3;

export type VolumeLevel = "NORMAL" | "ELEVATED" | "SURGE";

/**
 * Shared classifier so a simulated ratio from the shock injector is graded on
 * exactly the same scale as a real one — an injected 1.2x shouldn't be called
 * an anomaly when the app's own definition of one starts at 1.5x.
 */
export function classifyVolumeRatio(ratio: number | null): VolumeLevel {
  if (ratio === null || !Number.isFinite(ratio)) return "NORMAL";
  if (ratio >= VOLUME_SURGE_RATIO) return "SURGE";
  if (ratio >= VOLUME_ELEVATED_RATIO) return "ELEVATED";
  return "NORMAL";
}

// Same category of bug as the z-score display cap (see scoring.ts /
// ERRORS.md): `delta / baseline` is only guarded against the baseline being
// exactly 0, not against it being small. A run of quiet polls followed by
// one normal-volume poll can produce an arbitrarily large, genuinely-
// computed-but-uncommunicative ratio like "847.3x" — same failure mode,
// same fix: cap what's displayed, flag that it was capped.
const MAX_DISPLAY_RATIO = 10;

// How many consecutive polls a surge has to hold before it counts as
// confirmed. One 20-second print at 3x is thin evidence: NSE volume is
// U-shaped, so the last half hour of a session routinely prints multiples of
// the mid-session median on ordinary names. Two polls in a row is still fast
// (~40s) but rules out the single-tick blip, and it's what lets a surge carry
// full escalation weight without spraying CRITICAL across the whole list into
// the close. See scoring.ts for how the weights differ.
const SUSTAINED_SURGE_POLLS = 2;

export interface VolumeAnomalyResult {
  /** Convenience for "level !== NORMAL". */
  isAnomaly: boolean;
  level: VolumeLevel;
  ratio: number | null;
  /** True once a SURGE has held for SUSTAINED_SURGE_POLLS consecutive readings. */
  sustained: boolean;
  /** True if ratio hit the display ceiling (MAX_DISPLAY_RATIO) — the real ratio was even larger. */
  ratioClamped: boolean;
  isLive: boolean;
}

const NO_SIGNAL: VolumeAnomalyResult = {
  isAnomaly: false,
  level: "NORMAL",
  ratio: null,
  sustained: false,
  ratioClamped: false,
  isLive: false,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class VolumeAnomalyTracker {
  private lastCumulativeVolume: number | null = null;
  private deltas: number[] = [];
  private consecutiveSurges = 0;
  private readonly maxBufferSize = 30;
  private lastResult: VolumeAnomalyResult = NO_SIGNAL;

  constructor(public readonly symbol: string) {}

  /**
   * Feed the latest cumulative day-volume reading. Mutates state — call
   * exactly once per poll cycle (from marketFeedStore's poll loop), never
   * from a read path, or the rolling baseline gets corrupted by repeat calls.
   */
  addReading(cumulativeVolume: number): VolumeAnomalyResult {
    if (this.lastCumulativeVolume === null) {
      this.lastCumulativeVolume = cumulativeVolume;
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    const delta = cumulativeVolume - this.lastCumulativeVolume;
    this.lastCumulativeVolume = cumulativeVolume;

    // Cumulative volume resets at a new session (delta goes negative).
    // Also clear the rolling buffer, not just the last result — otherwise
    // the new session's early ratios blend against stale deltas left over
    // from the previous session (relevant here: this hackathon's window
    // has a real multi-day gap between Friday's and Monday's sessions, and
    // the server is designed to survive across it, see marketHours.ts).
    if (delta < 0) {
      this.deltas = [];
      this.consecutiveSurges = 0;
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    // A zero delta means nothing traded in that window. That is the *absence*
    // of a pace measurement, not a measurement of zero pace, and letting
    // zeros into the baseline is what made the first real print after a quiet
    // stretch read as a 30x anomaly — a false CRITICAL on essentially every
    // symbol shortly after the open. Zeros can't clear an existing signal
    // either, so the previous result stands untouched.
    if (delta === 0) return this.lastResult;

    if (this.deltas.length < MIN_DELTAS_FOR_LIVE) {
      this.deltas.push(delta);
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    // Median, not mean. Two reasons, both real:
    //   - A mean lets the baseline eat its own signal: a genuine multi-poll
    //     surge drags the average up and normalises itself away within a
    //     couple of minutes, so a sustained spike stops being an anomaly
    //     exactly while it's happening.
    //   - A single outlier in either direction distorts a 30-sample mean far
    //     more than it moves the middle value.
    const baseline = median(this.deltas);
    const rawRatio = baseline > 0 ? delta / baseline : 1;
    const ratioClamped = rawRatio > MAX_DISPLAY_RATIO;
    const ratio = ratioClamped ? MAX_DISPLAY_RATIO : rawRatio;

    this.deltas.push(delta);
    if (this.deltas.length > this.maxBufferSize) this.deltas.shift();

    // Classify on the RAW ratio, never the display-clamped one — capping is
    // a display concern (same separation scoring.ts keeps for the z-score).
    const level = classifyVolumeRatio(rawRatio);
    this.consecutiveSurges = level === "SURGE" ? this.consecutiveSurges + 1 : 0;

    this.lastResult = {
      isAnomaly: level !== "NORMAL",
      level,
      ratio,
      sustained: this.consecutiveSurges >= SUSTAINED_SURGE_POLLS,
      ratioClamped,
      isLive: true,
    };
    return this.lastResult;
  }

  /** Non-mutating read of the result from the most recent addReading() call. Safe to call from any read path. */
  getLastResult(): VolumeAnomalyResult {
    return this.lastResult;
  }
}
