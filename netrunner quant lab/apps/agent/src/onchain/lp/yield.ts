import type { GmxMarket } from "../gmx/client.js";

// FEE-YIELD + FUNDING-CARRY analyzer (the funding_carry widget). Two jobs:
//   1. Decompose an LP's net APR: gross fees − modeled IL drag − gas (− borrow if leveraged).
//   2. Read the venue's funding/borrow carry and flag whether holding a hedge PAYS you or COSTS you,
//      which is the key input to a delta-neutral "LP + GMX short hedge" structure.
// Pure/analytic; the inputs come from the discover + IL analyzers and the GMX market.

export interface NetYield {
  grossFeeAprPct: number;
  ilDragAprPct: number;       // annualized IL drag estimate (≥ 0, subtracted)
  gasAprPct: number;          // rebalance/gas drag as APR on the position
  netAprPct: number;          // gross − ilDrag − gas
  rationale: string;
}

// Convert a per-period IL (from clmm.concentratedIl over a typical move) + an expected rebalance
// frequency into an annualized drag. We approximate: each time price exits band you realize ~|IL| and
// re-center; rebalances/year ≈ (1 - timeInRange) scaled by horizon.
export function netYield(opts: {
  grossFeeAprPct: number;
  typicalIl: number;          // e.g. concentratedIl at the band edge (≤ 0)
  timeInRange: number;        // 0..1
  rebalancesPerYear: number;
  gasPerRebalanceUsd: number;
  positionUsd: number;
}): NetYield {
  const ilDragAnnual = Math.abs(opts.typicalIl) * Math.max(0, opts.rebalancesPerYear) * 100;
  const gasAnnual = opts.positionUsd > 0 ? (opts.gasPerRebalanceUsd * opts.rebalancesPerYear) / opts.positionUsd * 100 : 0;
  const net = opts.grossFeeAprPct - ilDragAnnual - gasAnnual;
  return {
    grossFeeAprPct: opts.grossFeeAprPct,
    ilDragAprPct: ilDragAnnual,
    gasAprPct: gasAnnual,
    netAprPct: net,
    rationale: `Net ≈ ${opts.grossFeeAprPct.toFixed(1)}% fees − ${ilDragAnnual.toFixed(1)}% IL drag − ${gasAnnual.toFixed(2)}% gas = ${net.toFixed(1)}% (at ${(opts.timeInRange * 100).toFixed(0)}% time-in-range, ~${opts.rebalancesPerYear.toFixed(0)} rebalances/yr).`,
  };
}

export interface Carry {
  fundingRateAnnualPct: number | null;  // GMX funding factor annualized (sign: + ⇒ longs pay shorts)
  borrowRateAnnualPct: number | null;
  carrySide: "shorts_paid" | "longs_paid" | "neutral";
  hedgeNote: string;
}

// GMX funding factor is per-second (we scaled it /1e30 in the client). Annualize and interpret for a
// hedge: a delta-neutral LP usually shorts the index — if shorts are PAID funding, the hedge has
// positive carry (great); if longs are paid, the short hedge bleeds funding (costs you).
export function carryFromGmx(m: GmxMarket | null): Carry {
  if (!m) return { fundingRateAnnualPct: null, borrowRateAnnualPct: null, carrySide: "neutral", hedgeNote: "No GMX market — carry unknown." };
  const fundingAnnual = m.fundingAnnualPct; // annualized % (verified scale)
  const borrowAnnual = m.borrowAnnualPct;   // annualized % (verified scale)
  // fundingRateLong > 0 ⇒ longs pay shorts. A short hedge then RECEIVES funding (positive carry).
  const side = Math.abs(fundingAnnual) < 0.5 ? "neutral" : fundingAnnual > 0 ? "shorts_paid" : "longs_paid";
  const hedgeNote = side === "shorts_paid"
    ? `Longs pay ~${fundingAnnual.toFixed(1)}%/yr — a delta-neutral SHORT hedge earns this funding (positive carry).`
    : side === "longs_paid"
      ? `Shorts pay ~${Math.abs(fundingAnnual).toFixed(1)}%/yr — a short hedge BLEEDS funding; prefer unhedged LP or a long-side structure.`
      : "Funding ≈ flat — hedge carry is roughly neutral.";
  return { fundingRateAnnualPct: fundingAnnual, borrowRateAnnualPct: borrowAnnual, carrySide: side, hedgeNote };
}
