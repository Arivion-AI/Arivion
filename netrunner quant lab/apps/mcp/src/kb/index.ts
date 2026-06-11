import { STRATEGIES, STRATEGY_ORDER_HELPERS } from "./strategies.js";
import { BOTS } from "./bots.js";
import {
  FILL_MODEL_REFERENCE, VENUE_REFERENCE, OPTIMIZER_REFERENCE, PORTFOLIO_REFERENCE,
  RECOMMENDER_REFERENCE, RISK_COCKPIT_REFERENCE, XSTOCKS_REFERENCE, CHAIN_REFERENCE,
  DEX_VENUE_REFERENCE, AMM_FILL_MODEL_REFERENCE, RUN_COMMON_PARAMS, TIERS,
} from "./reference.js";
import { ENV_REFERENCE } from "./env.js";
import { ERROR_CODES, explainCode } from "./errorCodes.js";
import type { CatalogEntry } from "./types.js";

export {
  STRATEGIES, BOTS, STRATEGY_ORDER_HELPERS, FILL_MODEL_REFERENCE, VENUE_REFERENCE,
  OPTIMIZER_REFERENCE, PORTFOLIO_REFERENCE, RECOMMENDER_REFERENCE, RISK_COCKPIT_REFERENCE,
  XSTOCKS_REFERENCE, CHAIN_REFERENCE, DEX_VENUE_REFERENCE, AMM_FILL_MODEL_REFERENCE,
  RUN_COMMON_PARAMS, TIERS, ENV_REFERENCE, ERROR_CODES, explainCode,
};

export type ParamKind =
  | "strategy" | "bot" | "run_common" | "portfolio_weighting" | "optimizer"
  | "venue" | "fill_model" | "risk_tolerance" | "recommender" | "risk_cockpit" | "xstocks"
  | "chains" | "dex_venues" | "amm_fill_model";

export function getStrategy(id: string): CatalogEntry | undefined {
  return STRATEGIES.find((s) => s.id === id);
}
export function getBot(id: string): CatalogEntry | undefined {
  return BOTS.find((b) => b.id === id);
}

export function strategyIds(): string[] {
  return STRATEGIES.map((s) => s.id);
}
export function botIds(): string[] {
  return BOTS.map((b) => b.id);
}

/** Backing data for the get_param_help tool. */
export function paramHelp(kind: ParamKind, id?: string): unknown {
  switch (kind) {
    case "strategy":
      return id ? getStrategy(id) ?? { error: `unknown strategy '${id}'`, available: strategyIds() } : STRATEGIES;
    case "bot":
      return id ? getBot(id) ?? { error: `unknown bot '${id}'`, available: botIds() } : BOTS;
    case "run_common":
      return { params: RUN_COMMON_PARAMS, note: "Common fields accepted by /api/paper/runtime/run and /api/bots/runs/*." };
    case "portfolio_weighting":
      return PORTFOLIO_REFERENCE;
    case "optimizer":
      return OPTIMIZER_REFERENCE;
    case "venue":
      return VENUE_REFERENCE;
    case "fill_model":
      return FILL_MODEL_REFERENCE;
    case "risk_tolerance":
      return { values: RECOMMENDER_REFERENCE.riskTolerance, denials: RECOMMENDER_REFERENCE.toleranceDenials };
    case "recommender":
      return RECOMMENDER_REFERENCE;
    case "risk_cockpit":
      return RISK_COCKPIT_REFERENCE;
    case "xstocks":
      return XSTOCKS_REFERENCE;
    case "chains":
      return CHAIN_REFERENCE;
    case "dex_venues":
      return DEX_VENUE_REFERENCE;
    case "amm_fill_model":
      return AMM_FILL_MODEL_REFERENCE;
    default:
      return { error: `unknown kind '${kind}'` };
  }
}

export const PARAM_KINDS: ParamKind[] = [
  "strategy", "bot", "run_common", "portfolio_weighting", "optimizer",
  "venue", "fill_model", "risk_tolerance", "recommender", "risk_cockpit", "xstocks",
  "chains", "dex_venues", "amm_fill_model",
];
