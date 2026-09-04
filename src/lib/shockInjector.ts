// Dev-only demo control: lets a presenter force an interesting state on a
// symbol on demand, since NSE is only live ~6 hours total across this whole
// hackathon window (see DECISIONS.md) — without this, most of the demo
// window has nothing happening to show.
//
// Deliberately non-destructive: this never touches the real volatility or
// volume trackers, so injecting a shock can't corrupt the genuine
// live-learned statistics for a symbol. It's a display/scoring *overlay*
// that scoring.ts applies on top of the real quote when present, and expires
// on its own so a demo can't get stuck in a fake state.

const SHOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface ShockOverride {
  /** e.g. -0.06 = simulate a 6% drop from the current real price. */
  priceOverridePct?: number;
  /** e.g. 4.2 = simulate a 4.2x volume spike. */
  volumeAnomalyRatio?: number;
  headline?: string;
  injectedAt: number;
}

export class ShockInjector {
  private overrides = new Map<string, ShockOverride>();

  inject(symbol: string, override: Omit<ShockOverride, "injectedAt">): void {
    this.overrides.set(symbol, { ...override, injectedAt: Date.now() });
  }

  clear(symbol: string): void {
    this.overrides.delete(symbol);
  }

  clearAll(): void {
    this.overrides.clear();
  }

  /** Returns the active override for a symbol, or null if none / expired (lazily evicted). */
  get(symbol: string): ShockOverride | null {
    const o = this.overrides.get(symbol);
    if (!o) return null;
    if (Date.now() - o.injectedAt > SHOCK_TTL_MS) {
      this.overrides.delete(symbol);
      return null;
    }
    return o;
  }

  listActiveSymbols(): string[] {
    return Array.from(this.overrides.keys()).filter((s) => this.get(s) !== null);
  }
}
