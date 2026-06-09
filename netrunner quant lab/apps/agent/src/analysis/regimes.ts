// Phase 32 — PURE bull/bear REGIME DETECTION. Instead of fixed calendar windows (2021 bull / 2022
// bear — stale, and absent for newer tokens), we segment a token's FULL daily price history into
// alternating bull and bear "seasons" using the textbook ±threshold swing rule (a bear = a ≥20% drop
// from a peak, a bull = a ≥20% rise from a trough). This finds every cycle across all available years.
// No I/O — unit-tested in test/regimes.unit.test.ts.

export interface RegimeSegment {
  type: "bull" | "bear";
  startIdx: number;
  endIdx: number;
  startMs: number;
  endMs: number;
  startPrice: number;
  endPrice: number;
  return: number; // (end-start)/start over the segment
  days: number;
  label: string; // e.g. "2021-01 → 2021-11"
}

function ym(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Zigzag swing filter: track the running high and low since the last pivot; confirm a turning point
// only after price retraces `threshold` from that extreme. Pivots mark the turns; the spans between
// them are the bull/bear seasons. (dir: 0 unknown, 1 rising-leg, -1 falling-leg.)
export function detectRegimes(closes: number[], ts: number[], threshold = 0.2): RegimeSegment[] {
  const n = closes.length;
  if (n < 2 || ts.length !== n) return [];
  const pivots: number[] = [0];
  let lastPivot = 0;
  let hiIdx = 0;
  let loIdx = 0;
  let dir = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[hiIdx]) hiIdx = i;
    if (closes[i] < closes[loIdx]) loIdx = i;
    // rising or unknown → watch for a `threshold` drop off the running high (ends an up-leg at the high)
    if (dir >= 0 && hiIdx > lastPivot && closes[hiIdx] > 0 && (closes[hiIdx] - closes[i]) / closes[hiIdx] >= threshold) {
      pivots.push(hiIdx); lastPivot = hiIdx; dir = -1; hiIdx = i; loIdx = i; continue;
    }
    // falling or unknown → watch for a `threshold` rise off the running low (ends a down-leg at the low)
    if (dir <= 0 && loIdx > lastPivot && closes[loIdx] > 0 && (closes[i] - closes[loIdx]) / closes[loIdx] >= threshold) {
      pivots.push(loIdx); lastPivot = loIdx; dir = 1; hiIdx = i; loIdx = i; continue;
    }
  }
  if (pivots[pivots.length - 1] !== n - 1) pivots.push(n - 1);

  const segs: RegimeSegment[] = [];
  for (let k = 0; k < pivots.length - 1; k++) {
    const a = pivots[k];
    const b = pivots[k + 1];
    if (b <= a || !(closes[a] > 0)) continue;
    const ret = (closes[b] - closes[a]) / closes[a];
    segs.push({
      type: ret >= 0 ? "bull" : "bear",
      startIdx: a, endIdx: b, startMs: ts[a], endMs: ts[b],
      startPrice: closes[a], endPrice: closes[b], return: ret,
      days: Math.max(1, Math.round((ts[b] - ts[a]) / 86_400_000)),
      label: `${ym(ts[a])} → ${ym(ts[b])}`,
    });
  }
  return segs;
}

export interface RegimeAggregate {
  n: number;
  avg_return: number; // simple mean of segment returns
  compounded_return: number; // chaining the segment returns (geometric)
  win_rate: number; // fraction of segments with positive return
  best: number;
  worst: number;
}

// Aggregate a set of per-season returns into a bull/bear summary.
export function aggregateReturns(returns: number[]): RegimeAggregate {
  const n = returns.length;
  if (!n) return { n: 0, avg_return: 0, compounded_return: 0, win_rate: 0, best: 0, worst: 0 };
  const avg = returns.reduce((s, r) => s + r, 0) / n;
  const comp = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const wins = returns.filter((r) => r > 0).length;
  return {
    n, avg_return: Number(avg.toFixed(4)), compounded_return: Number(comp.toFixed(4)),
    win_rate: Number((wins / n).toFixed(2)), best: Number(Math.max(...returns).toFixed(4)), worst: Number(Math.min(...returns).toFixed(4)),
  };
}
