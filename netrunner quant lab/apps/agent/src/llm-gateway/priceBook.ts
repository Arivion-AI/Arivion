import type pg from "pg";
import { db } from "../db.js";
import type { PriceRow } from "./types.js";

// Governed price book (correction #7). Returns the price row active *now* for a provider/model, or
// null. A null result for a managed call MUST block the call upstream (no silent free billing).
export async function getActivePrice(
  provider: string,
  model: string,
  q: Pick<pg.PoolClient, "query"> = db,
): Promise<PriceRow | null> {
  const res = await q.query<PriceRow>(
    `SELECT provider, model,
            input_micro_usd_per_mtoken, cached_input_micro_usd_per_mtoken,
            output_micro_usd_per_mtoken, reasoning_micro_usd_per_mtoken,
            source, source_url, fetched_at, effective_from, effective_to
       FROM agent_model_price_book
      WHERE provider = $1 AND model = $2
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      ORDER BY effective_from DESC
      LIMIT 1`,
    [provider, model],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  // pg returns BIGINT as string — normalize the numeric columns.
  return {
    ...r,
    input_micro_usd_per_mtoken: Number(r.input_micro_usd_per_mtoken),
    cached_input_micro_usd_per_mtoken:
      r.cached_input_micro_usd_per_mtoken === null ? null : Number(r.cached_input_micro_usd_per_mtoken),
    output_micro_usd_per_mtoken: Number(r.output_micro_usd_per_mtoken),
    reasoning_micro_usd_per_mtoken:
      r.reasoning_micro_usd_per_mtoken === null ? null : Number(r.reasoning_micro_usd_per_mtoken),
  };
}

// All currently-priced managed models (used by the model catalog).
export async function listActivePrices(): Promise<PriceRow[]> {
  const res = await db.query<PriceRow>(
    `SELECT DISTINCT ON (provider, model)
            provider, model,
            input_micro_usd_per_mtoken, cached_input_micro_usd_per_mtoken,
            output_micro_usd_per_mtoken, reasoning_micro_usd_per_mtoken,
            source, source_url, fetched_at, effective_from, effective_to
       FROM agent_model_price_book
      WHERE effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      ORDER BY provider, model, effective_from DESC`,
  );
  return res.rows.map((r) => ({
    ...r,
    input_micro_usd_per_mtoken: Number(r.input_micro_usd_per_mtoken),
    cached_input_micro_usd_per_mtoken:
      r.cached_input_micro_usd_per_mtoken === null ? null : Number(r.cached_input_micro_usd_per_mtoken),
    output_micro_usd_per_mtoken: Number(r.output_micro_usd_per_mtoken),
    reasoning_micro_usd_per_mtoken:
      r.reasoning_micro_usd_per_mtoken === null ? null : Number(r.reasoning_micro_usd_per_mtoken),
  }));
}
