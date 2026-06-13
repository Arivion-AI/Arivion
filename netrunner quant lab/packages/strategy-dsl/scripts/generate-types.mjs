import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const schemaPath = resolve(root, "strategy.schema.json");
const schemaRaw = readFileSync(schemaPath, "utf8");
const schemaHash = createHash("sha256").update(schemaRaw).digest("hex").slice(0, 16);

const tsOut = `/* auto-generated from strategy.schema.json; schema_sha256=${schemaHash} */
export type RequirementValue = "REQUIRED" | "REQUIRED_NATIVE_CADENCE" | "OPTIONAL_SUBJECT_TO_RETENTION" | "NOT_USED";

export type StrategySpec = {
  strategy: {
    name: string;
    universe: {
      category: string;
      symbols: string[];
      timeframe: string;
      timezone: string;
    };
    data_requirements: Record<string, RequirementValue> & {
      candles: RequirementValue;
      mark_price: RequirementValue;
      funding_rates: RequirementValue;
      open_interest: RequirementValue;
      orderbook_depth: RequirementValue;
    };
    features: Record<string, unknown>;
    entry: Record<string, unknown>;
    exit: Record<string, unknown>;
    sizing: {
      type: string;
      max_position_fraction: number;
      [key: string]: unknown;
    };
    risk: {
      max_leverage: number;
      max_daily_loss_fraction: number;
      max_drawdown_kill_fraction: number;
      [key: string]: unknown;
    };
    accounting: {
      perp_funding: "funding_history_timestamp_driven";
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};
`;

const pyOut = `# auto-generated from strategy.schema.json; schema_sha256=${schemaHash}
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal

RequirementValue = Literal["REQUIRED", "REQUIRED_NATIVE_CADENCE", "OPTIONAL_SUBJECT_TO_RETENTION", "NOT_USED"]


@dataclass
class Universe:
    category: str
    symbols: List[str]
    timeframe: str
    timezone: str


@dataclass
class Sizing:
    type: str
    max_position_fraction: float
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Risk:
    max_leverage: float
    max_daily_loss_fraction: float
    max_drawdown_kill_fraction: float
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Accounting:
    perp_funding: Literal["funding_history_timestamp_driven"]
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Strategy:
    name: str
    universe: Universe
    data_requirements: Dict[str, RequirementValue]
    features: Dict[str, Any]
    entry: Dict[str, Any]
    exit: Dict[str, Any]
    sizing: Sizing
    risk: Risk
    accounting: Accounting


@dataclass
class StrategySpec:
    strategy: Strategy
`;

writeFileSync(resolve(root, "generated/strategy-spec.ts"), tsOut, "utf8");
writeFileSync(resolve(root, "generated/strategy_spec.py"), pyOut, "utf8");

console.log("generated strategy DSL types", { schemaHash });
