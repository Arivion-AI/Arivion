import { db } from "../db.js";
import { config } from "../config.js";
import { listActivePrices } from "./priceBook.js";
import { PROVIDER_REGISTRY } from "./keyVault.js";

// The managed model catalog is exactly the set of provider/model pairs that have an ACTIVE price
// row AND an allowlisted provider (correction #7: no price ⇒ not callable as managed).

export interface CatalogEntry {
  provider: string;
  model: string;
  providerLabel: string;
  input_micro_usd_per_mtoken: number;
  cached_input_micro_usd_per_mtoken: number | null;
  output_micro_usd_per_mtoken: number;
  source: string;
  source_url: string | null;
}

export async function getManagedCatalog(): Promise<CatalogEntry[]> {
  const prices = await listActivePrices();
  return prices
    .filter((p) => PROVIDER_REGISTRY[p.provider])
    .map((p) => ({
      provider: p.provider,
      model: p.model,
      providerLabel: PROVIDER_REGISTRY[p.provider].label,
      input_micro_usd_per_mtoken: p.input_micro_usd_per_mtoken,
      cached_input_micro_usd_per_mtoken: p.cached_input_micro_usd_per_mtoken,
      output_micro_usd_per_mtoken: p.output_micro_usd_per_mtoken,
      source: p.source,
      source_url: p.source_url,
    }));
}

// Per-owner model preferences. Defaults are created lazily; default_model falls back to a managed
// model that is actually priced (so a fresh owner never points at an uncallable model).
export interface ModelPreferences {
  owner_id: number;
  default_provider_mode: string;
  default_provider: string;
  default_model: string;
  planner_model: string | null;
  actor_model: string | null;
  triage_model: string | null;
  embedding_model: string | null;
  fallback_policy: string;
}

// Default model. Venice AI is the primary brain when a VENICE_API_KEY is present.
// The default is the high-volume actor/triage model; deep planning can still escalate via
// planner_model (resolveModels honors it; null falls back to this default). Gated by "must be priced":
// getPreferences falls back to any priced non-mock model if this isn't priced, so the chosen default
// MUST have a row in agent_model_price_book (Venice: migration 0032). Picking an
// unpriced/keyless default silently breaks the Copilot for new owners.
const FALLBACK_DEFAULT = config.defaultProvider === "venice"
  ? { provider: "venice", model: config.veniceModel }
  : { provider: config.defaultProvider, model: config.veniceModel };

// Resolve the role-specific models from a preferences row. planner/actor/triage each fall back to the
// owner's default_model, so these columns are honored when set and harmless when null. The chat loop
// uses `actor` (the model that decides and calls tools); the orchestrated/planning paths use `planner`.
export function resolveModels(prefs: ModelPreferences): { planner: string; actor: string; triage: string } {
  return {
    planner: prefs.planner_model ?? prefs.default_model,
    actor: prefs.actor_model ?? prefs.default_model,
    triage: prefs.triage_model ?? prefs.default_model,
  };
}

export async function getPreferences(ownerId: number): Promise<ModelPreferences> {
  const existing = await db.query(`SELECT * FROM agent_model_preferences WHERE owner_id = $1`, [ownerId]);
  if (existing.rowCount) return rowToPrefs(existing.rows[0]);

  // Lazily create defaults. Prefer the configured FALLBACK_DEFAULT (a cheap "mini" model) when it is
  // priced/available; otherwise fall back to any non-mock priced model, then anything priced.
  const catalog = await getManagedCatalog();
  const preferred = catalog.find(
    (c) => c.provider === FALLBACK_DEFAULT.provider && c.model === FALLBACK_DEFAULT.model,
  );
  // Prefer the configured default provider over any other non-mock model, so the lazy default is
  // runnable rather than a keyless model.
  const priced = preferred
    ?? catalog.find((c) => c.provider === FALLBACK_DEFAULT.provider)
    ?? catalog.find((c) => c.provider !== "mock")
    ?? catalog[0];
  const provider = priced?.provider ?? FALLBACK_DEFAULT.provider;
  const model = priced?.model ?? FALLBACK_DEFAULT.model;
  const ins = await db.query(
    `INSERT INTO agent_model_preferences (owner_id, default_provider_mode, default_provider, default_model)
     VALUES ($1, 'managed', $2, $3)
     ON CONFLICT (owner_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [ownerId, provider, model],
  );
  return rowToPrefs(ins.rows[0]);
}

export async function updatePreferences(
  ownerId: number,
  patch: Partial<Omit<ModelPreferences, "owner_id">>,
): Promise<ModelPreferences> {
  await getPreferences(ownerId); // ensure row exists
  const res = await db.query(
    `UPDATE agent_model_preferences SET
        default_provider_mode = COALESCE($2, default_provider_mode),
        default_provider      = COALESCE($3, default_provider),
        default_model         = COALESCE($4, default_model),
        planner_model         = COALESCE($5, planner_model),
        actor_model           = COALESCE($6, actor_model),
        triage_model          = COALESCE($7, triage_model),
        embedding_model       = COALESCE($8, embedding_model),
        fallback_policy       = COALESCE($9, fallback_policy),
        updated_at            = now()
      WHERE owner_id = $1
      RETURNING *`,
    [
      ownerId, patch.default_provider_mode ?? null, patch.default_provider ?? null, patch.default_model ?? null,
      patch.planner_model ?? null, patch.actor_model ?? null, patch.triage_model ?? null,
      patch.embedding_model ?? null, patch.fallback_policy ?? null,
    ],
  );
  return rowToPrefs(res.rows[0]);
}

function rowToPrefs(r: Record<string, unknown>): ModelPreferences {
  return {
    owner_id: Number(r.owner_id),
    default_provider_mode: String(r.default_provider_mode),
    default_provider: String(r.default_provider),
    default_model: String(r.default_model),
    planner_model: (r.planner_model as string) ?? null,
    actor_model: (r.actor_model as string) ?? null,
    triage_model: (r.triage_model as string) ?? null,
    embedding_model: (r.embedding_model as string) ?? null,
    fallback_policy: String(r.fallback_policy),
  };
}
