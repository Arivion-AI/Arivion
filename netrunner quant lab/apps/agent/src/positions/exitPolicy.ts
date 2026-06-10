import { z } from "zod";

// Phase 17 — the EXIT POLICY: the consequences a managed position carries from the moment it opens.
// This module is PURE (no DB, no IO) so the entire stop-loss / take-profit / trailing / time-exit /
// max-loss decision logic is deterministic and unit-testable. The monitor (positions/monitor.ts)
// feeds it the current mark and acts on the returned decision.
//
// Modeled on the bracket/OCO + tiered-TP + ratchet-trailing patterns that real always-on traders use
// (Lumibot bracket orders, go-trader's reduce-only TP ladder + monotonic ratchet stop). Everything is
// expressed in PERCENT of entry so it needs no position-quantity bookkeeping.

export const StopLossSchema = z.object({
  type: z.enum(["fixed_pct", "atr_mult"]),
  // fixed_pct: fraction below entry (long), e.g. 0.05 = 5%. atr_mult: multiples of ATR.
  value: z.number().positive(),
});

export const TakeProfitTierSchema = z.object({
  target_pct: z.number().positive(), // gain fraction from entry, e.g. 0.015 = +1.5%
  reduce_fraction: z.number().positive().max(1), // fraction of the position to close at this tier
});

export const TakeProfitSchema = z.object({
  // Tiers MUST be sorted ascending by target_pct; cumulative reduce_fraction should reach ~1.0.
  ladder: z.array(TakeProfitTierSchema).min(1),
});

export const TrailingSchema = z.object({
  activate_at_pct: z.number().nonnegative(), // start trailing once gain ≥ this
  trail_pct: z.number().positive(), // distance below the high-water mark (long)
  ratchet: z.boolean().default(true), // monotonically tighten the stop, never loosen
});

export const TimeExitSchema = z.object({
  max_hold_seconds: z.number().int().positive(),
});

export const ExitPolicySchema = z.object({
  stop_loss: StopLossSchema, // REQUIRED — a managed position can never be naked.
  take_profit: TakeProfitSchema.optional(),
  trailing: TrailingSchema.optional(),
  time_exit: TimeExitSchema.optional(),
  max_loss_pct: z.number().positive().optional(), // hard loss cap independent of the stop
});
export type ExitPolicy = z.infer<typeof ExitPolicySchema>;
export type StopLoss = z.infer<typeof StopLossSchema>;

// Mutable per-position state the monitor advances each tick.
export interface PositionRuntime {
  high_water: number; // best price seen (for long) since open
  low_water: number; // worst price seen (for long) since open
  cleared_tiers: number[]; // indices of take-profit tiers already taken
  current_stop_price: number | null; // effective stop after ratcheting; null = derive from policy
}

export type Side = "long" | "short";

export interface PositionView {
  side: Side;
  entry_price: number;
  opened_at_ms: number;
  policy: ExitPolicy;
  runtime: PositionRuntime;
  atr?: number; // optional ATR at entry, required only for stop_loss.type === "atr_mult"
}

export type ExitReason =
  | "stop_loss"
  | "trailing_stop"
  | "take_profit"
  | "take_profit_final"
  | "time_exit"
  | "max_loss";

export interface ExitDecision {
  action: "hold" | "reduce" | "close";
  reason?: ExitReason;
  fraction?: number; // for reduce/close: fraction of the (remaining) position to exit
  tier_index?: number; // which TP tier triggered a reduce
  unrealized: number; // current unrealized return fraction (side-adjusted)
  // The runtime to persist after this evaluation (high-water/stop/tiers advanced).
  next_runtime: PositionRuntime;
}

// Side-adjusted unrealized return: +ve = in profit, for both long and short.
export function unrealizedReturn(side: Side, entry: number, mark: number): number {
  if (entry <= 0) return 0;
  const raw = (mark - entry) / entry;
  return side === "long" ? raw : -raw;
}

// Base stop PRICE implied by the policy's stop_loss (before any trailing/ratchet adjustment).
export function baseStopPrice(side: Side, entry: number, sl: StopLoss, atr?: number): number {
  if (sl.type === "atr_mult") {
    const dist = (atr ?? 0) * sl.value;
    return side === "long" ? entry - dist : entry + dist;
  }
  // fixed_pct
  return side === "long" ? entry * (1 - sl.value) : entry * (1 + sl.value);
}

// Is `mark` at or beyond `stop` in the losing direction for this side?
function stopHit(side: Side, mark: number, stop: number): boolean {
  return side === "long" ? mark <= stop : mark >= stop;
}

// Has `mark` reached the take-profit target for this side?
function targetHit(side: Side, entry: number, targetPct: number, mark: number): boolean {
  const target = side === "long" ? entry * (1 + targetPct) : entry * (1 - targetPct);
  return side === "long" ? mark >= target : mark <= target;
}

export function initRuntime(view: { side: Side; entry_price: number; policy: ExitPolicy; atr?: number }): PositionRuntime {
  return {
    high_water: view.entry_price,
    low_water: view.entry_price,
    cleared_tiers: [],
    current_stop_price: baseStopPrice(view.side, view.entry_price, view.policy.stop_loss, view.atr),
  };
}

// THE decision function. Given a position and the current mark, decide hold / reduce / close and
// return the advanced runtime. Order of precedence (most protective first):
//   1. hard stop / trailing stop / max-loss  → CLOSE
//   2. time exit                              → CLOSE
//   3. take-profit tier crossed               → REDUCE (or CLOSE if it's the final/total tier)
// Ratchet: each cleared TP tier raises the stop to at least the prior tier's price (breakeven for the
// first tier), and an active trailing stop tightens it toward the high-water mark — monotonically.
export function evaluateExit(view: PositionView, mark: number, nowMs: number): ExitDecision {
  const { side, entry_price: entry, policy } = view;
  const rt: PositionRuntime = {
    high_water: side === "long" ? Math.max(view.runtime.high_water, mark) : view.runtime.high_water,
    low_water: side === "long" ? Math.min(view.runtime.low_water, mark) : view.runtime.low_water,
    cleared_tiers: [...view.runtime.cleared_tiers],
    current_stop_price: view.runtime.current_stop_price ?? baseStopPrice(side, entry, policy.stop_loss, view.atr),
  };
  // For a short, "high_water"/"low_water" track the favorable/adverse extremes too.
  if (side === "short") {
    rt.high_water = Math.min(view.runtime.high_water, mark); // best (lowest) price for a short
    rt.low_water = Math.max(view.runtime.low_water, mark);
  }
  const unrealized = unrealizedReturn(side, entry, mark);

  // --- Ratchet the stop from cleared take-profit tiers (monotonic, never loosens) ---
  if (policy.take_profit && rt.cleared_tiers.length > 0) {
    const sorted = [...policy.take_profit.ladder].map((t, i) => ({ ...t, i }));
    const maxCleared = Math.max(...rt.cleared_tiers);
    // Lock in at least breakeven once any tier clears; lift to the prior tier's price beyond that.
    let lockPct = 0; // breakeven
    if (maxCleared >= 1) lockPct = sorted[maxCleared - 1].target_pct;
    const lockPrice = side === "long" ? entry * (1 + lockPct) : entry * (1 - lockPct);
    rt.current_stop_price = tighten(side, rt.current_stop_price, lockPrice);
  }

  // --- Trailing stop ---
  if (policy.trailing) {
    const peakGain = unrealizedReturn(side, entry, rt.high_water);
    if (peakGain >= policy.trailing.activate_at_pct) {
      const trailStop =
        side === "long"
          ? rt.high_water * (1 - policy.trailing.trail_pct)
          : rt.high_water * (1 + policy.trailing.trail_pct);
      rt.current_stop_price = policy.trailing.ratchet
        ? tighten(side, rt.current_stop_price, trailStop)
        : trailStop;
    }
  }

  // 1. Stop / trailing stop.
  if (rt.current_stop_price != null && stopHit(side, mark, rt.current_stop_price)) {
    // Distinguish a pure protective stop from a trailing/ratcheted one for the audit trail.
    const base = baseStopPrice(side, entry, policy.stop_loss, view.atr);
    const reason: ExitReason = tighter(side, rt.current_stop_price, base) ? "trailing_stop" : "stop_loss";
    return { action: "close", reason, fraction: 1, unrealized, next_runtime: rt };
  }

  // 1b. Hard max-loss cap (independent of the stop).
  if (policy.max_loss_pct != null && unrealized <= -policy.max_loss_pct) {
    return { action: "close", reason: "max_loss", fraction: 1, unrealized, next_runtime: rt };
  }

  // 2. Time exit.
  if (policy.time_exit && nowMs - view.opened_at_ms >= policy.time_exit.max_hold_seconds * 1000) {
    return { action: "close", reason: "time_exit", fraction: 1, unrealized, next_runtime: rt };
  }

  // 3. Take-profit ladder — fire the highest not-yet-cleared tier whose target is reached.
  if (policy.take_profit) {
    const tiers = policy.take_profit.ladder
      .map((t, i) => ({ ...t, i }))
      .filter((t) => !rt.cleared_tiers.includes(t.i) && targetHit(side, entry, t.target_pct, mark))
      .sort((a, b) => b.target_pct - a.target_pct);
    if (tiers.length > 0) {
      const tier = tiers[0];
      rt.cleared_tiers.push(tier.i);
      // Lock in gains the instant a tier clears: ratchet the stop up to at least breakeven (first
      // tier) or the prior tier's price (monotonic — never loosens).
      const lockPct = tier.i >= 1 ? policy.take_profit.ladder[tier.i - 1].target_pct : 0;
      const lockPrice = side === "long" ? entry * (1 + lockPct) : entry * (1 - lockPct);
      rt.current_stop_price = tighten(side, rt.current_stop_price, lockPrice);
      const cumulative = policy.take_profit.ladder
        .filter((_, i) => rt.cleared_tiers.includes(i))
        .reduce((s, t) => s + t.reduce_fraction, 0);
      const isFinal = tier.i === policy.take_profit.ladder.length - 1 || cumulative >= 0.999;
      return {
        action: isFinal ? "close" : "reduce",
        reason: isFinal ? "take_profit_final" : "take_profit",
        fraction: isFinal ? 1 : tier.reduce_fraction,
        tier_index: tier.i,
        unrealized,
        next_runtime: rt,
      };
    }
  }

  return { action: "hold", unrealized, next_runtime: rt };
}

// Move a stop in the protective direction only (up for long, down for short). Never loosens.
function tighten(side: Side, current: number | null, candidate: number): number {
  if (current == null) return candidate;
  return side === "long" ? Math.max(current, candidate) : Math.min(current, candidate);
}

// Is `a` strictly tighter (more protective) than `b`?
function tighter(side: Side, a: number, b: number): boolean {
  return side === "long" ? a > b : a < b;
}

export interface PolicyValidation {
  ok: boolean;
  reason?: string;
}

// Structural validation used by the guardrail that forbids naked entries. A managed position MUST
// carry a stop-loss AND at least one exit condition (the stop already qualifies, but we also sanity
// check ladder ordering and that something can actually close the position).
export function validateExitPolicy(input: unknown): PolicyValidation {
  const parsed = ExitPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: `invalid exit_policy: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const p = parsed.data;
  if (p.take_profit) {
    const t = p.take_profit.ladder;
    for (let i = 1; i < t.length; i++) {
      if (t[i].target_pct <= t[i - 1].target_pct) {
        return { ok: false, reason: "take_profit ladder must be strictly ascending by target_pct" };
      }
    }
    const cum = t.reduce((s, x) => s + x.reduce_fraction, 0);
    if (cum > 1.0001) return { ok: false, reason: `take_profit reduce_fraction sums to ${cum.toFixed(2)} > 1` };
  }
  if (p.stop_loss.type === "fixed_pct" && p.stop_loss.value >= 1) {
    return { ok: false, reason: "stop_loss fixed_pct must be < 1 (a fraction below entry)" };
  }
  return { ok: true };
}
