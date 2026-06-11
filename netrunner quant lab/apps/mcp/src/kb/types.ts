// Shared knowledge-base types. A ParamSpec is the structured, agent-readable
// description of a single parameter: enough for "which value goes here?".

export type ParamType =
  | "decimal"
  | "int"
  | "enum"
  | "bool"
  | "string"
  | "array"
  | "object";

export interface ParamSpec {
  name: string;
  type: ParamType;
  default?: unknown;
  required?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string; // "bps" | "fraction" | "qty" | "bars" | "USDT" | "x(leverage)" | ...
  description: string;
  verifiedTierImplication?: string;
  relatedErrorCodes?: string[];
}

export interface CatalogEntry {
  id: string;
  title: string;
  category: string; // grouping label
  riskClass?: string;
  summary: string;
  params: ParamSpec[];
  dataRequirements?: string[];
  eligibilityNotes?: string[];
}
