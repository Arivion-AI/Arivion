import { ilCurve, timeInRange, suggestBand, capitalEfficiency, type IlPoint } from "../uniswap/clmm.js";
import { realizedVol } from "../../analysis/indicators.js";

// IL / RANGE analyzer (the il_curve widget). Given a recent price path, it (a) suggests a concentrated
// band that targets a time-in-range, (b) computes the IL-vs-price curve for that band, (c) estimates
// time-in-range from the real path, and (d) reports the capital-efficiency multiplier vs full range.
// Pure analysis on a provided price series — deterministic, no I/O.

export interface IlAnalysis {
  band: { lowerPct: number; upperPct: number };   // band bounds as ± % around spot
  timeInRangePct: number;                           // from the historical path
  capitalEfficiency: number;                        // vs full-range (v2)
  realizedVolAnnualPct: number | null;
  ilCurve: IlPoint[];                               // for the chart
  breakevenNote: string;
  rationale: string;
}

// `closes` newest-last daily closes; `horizonDays` the intended hold; `targetTimeInRange` how often we
// want price to stay in band (wider band = more time-in-range, less fee concentration).
export function analyzeIl(closes: number[], opts: { horizonDays?: number; targetTimeInRange?: number; band?: { lower: number; upper: number } } = {}): IlAnalysis {
  const horizon = opts.horizonDays ?? 30;
  const target = opts.targetTimeInRange ?? 0.8;
  const volDaily = (realizedVol(closes) ?? 0); // per-day std of log returns
  const band = opts.band ?? suggestBand(volDaily, horizon, target);
  const tir = timeInRange(closes, band.lower, band.upper);
  const eff = capitalEfficiency(band.lower, band.upper);
  const curve = ilCurve(band.lower, band.upper);
  const lowerPct = (band.lower - 1) * 100, upperPct = (band.upper - 1) * 100;
  return {
    band: { lowerPct, upperPct },
    timeInRangePct: tir * 100,
    capitalEfficiency: eff,
    realizedVolAnnualPct: volDaily ? volDaily * Math.sqrt(365) * 100 : null,
    ilCurve: curve,
    breakevenNote: `LP earns fees only while price is in [${lowerPct.toFixed(1)}%, +${upperPct.toFixed(1)}%]; ~${(tir * 100).toFixed(0)}% of the recent path stayed in band.`,
    rationale: `Band ±${((upperPct - lowerPct) / 2).toFixed(1)}% targets ${(target * 100).toFixed(0)}% time-in-range at ${volDaily ? (volDaily * Math.sqrt(365) * 100).toFixed(0) : "?"}% annual vol; concentrates capital ${eff.toFixed(1)}× vs full range (≈${eff.toFixed(1)}× the fees while in range, but IL bites harder outside it).`,
  };
}
