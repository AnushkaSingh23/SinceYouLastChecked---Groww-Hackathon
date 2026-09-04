// Volume-anomaly detection, live-only — no historical average-volume
// dependency (same philosophy as volatility.ts: we don't guess at data we
// don't have; we wait until we've observed enough this session to say
// something with confidence, and say plainly when we haven't yet).
//
// Yahoo's `regularMarketVolume` is cumulative shares traded so far *today*,
// not a per-tick count, so we track the delta between consecutive polls
// (shares traded in that ~20s window) and compare the latest delta against
// this session's own rolling average delta for that symbol.

const MIN_DELTAS_FOR_LIVE = 5;
// Exported so the shock injector can classify a simulated ratio the same
// way real data is classified, instead of unconditionally calling any
// injected ratio "an anomaly" regardless of its value.
export const ANOMALY_RATIO_THRESHOLD = 2.5;

// Same category of bug as the z-score display cap (see scoring.ts /
// ERRORS.md): `delta / avgDelta` is only guarded against avgDelta being
// exactly 0, not against it being small. A run of quiet polls followed by
// one normal-volume poll can produce an arbitrarily large, genuinely-
// computed-but-uncommunicative ratio like "847.3x" — same failure mode,
// same fix: cap what's displayed, flag that it was capped.
const MAX_DISPLAY_RATIO = 10;

export interface VolumeAnomalyResult {
  isAnomaly: boolean;
  ratio: number | null;
  /** True if ratio hit the display ceiling (MAX_DISPLAY_RATIO) — the real ratio was even larger. */
  ratioClamped: boolean;
  isLive: boolean;
}

const NO_SIGNAL: VolumeAnomalyResult = { isAnomaly: false, ratio: null, ratioClamped: false, isLive: false };

export class VolumeAnomalyTracker {
  private lastCumulativeVolume: number | null = null;
  private deltas: number[] = [];
  private readonly maxBufferSize = 30;
  private lastResult: VolumeAnomalyResult = NO_SIGNAL;

  constructor(public readonly symbol: string) {}

  /**
   * Feed the latest cumulative day-volume reading. Mutates state — call
   * exactly once per poll cycle (from marketFeedStore's poll loop), never
   * from a read path, or the rolling average gets corrupted by repeat calls.
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
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    if (this.deltas.length < MIN_DELTAS_FOR_LIVE) {
      this.deltas.push(delta);
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    const avgDelta = this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length;
    const rawRatio = avgDelta > 0 ? delta / avgDelta : 1;
    const ratioClamped = rawRatio > MAX_DISPLAY_RATIO;
    const ratio = ratioClamped ? MAX_DISPLAY_RATIO : rawRatio;

    this.deltas.push(delta);
    if (this.deltas.length > this.maxBufferSize) this.deltas.shift();

    this.lastResult = { isAnomaly: rawRatio >= ANOMALY_RATIO_THRESHOLD, ratio, ratioClamped, isLive: true };
    return this.lastResult;
  }

  /** Non-mutating read of the result from the most recent addReading() call. Safe to call from any read path. */
  getLastResult(): VolumeAnomalyResult {
    return this.lastResult;
  }
}
