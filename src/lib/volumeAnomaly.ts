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
const ANOMALY_RATIO_THRESHOLD = 2.5;

export interface VolumeAnomalyResult {
  isAnomaly: boolean;
  ratio: number | null;
  isLive: boolean;
}

const NO_SIGNAL: VolumeAnomalyResult = { isAnomaly: false, ratio: null, isLive: false };

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

    // Cumulative volume resets at a new session (delta goes negative) — drop it.
    if (delta < 0) {
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    if (this.deltas.length < MIN_DELTAS_FOR_LIVE) {
      this.deltas.push(delta);
      this.lastResult = NO_SIGNAL;
      return this.lastResult;
    }

    const avgDelta = this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length;
    const ratio = avgDelta > 0 ? delta / avgDelta : 1;

    this.deltas.push(delta);
    if (this.deltas.length > this.maxBufferSize) this.deltas.shift();

    this.lastResult = { isAnomaly: ratio >= ANOMALY_RATIO_THRESHOLD, ratio, isLive: true };
    return this.lastResult;
  }

  /** Non-mutating read of the result from the most recent addReading() call. Safe to call from any read path. */
  getLastResult(): VolumeAnomalyResult {
    return this.lastResult;
  }
}
