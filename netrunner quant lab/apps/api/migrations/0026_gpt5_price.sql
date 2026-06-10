-- 0026: Price-book rows for GPT-5 / GPT-5 mini.
-- The Copilot's default model is openai/gpt-5-mini (apps/agent llm-gateway/modelCatalog.ts). A managed
-- call with no ACTIVE price row is BLOCKED by design, so the default needs a row here or new owners
-- silently fall back to gpt-4o-mini. gpt-5 is added too for the planner-escalation path. Costs are
-- micro-USD per million tokens. Marked UNVERIFIED placeholders (same convention as 0014) — verify
-- against OpenAI's live pricing before production billing.
INSERT INTO agent_model_price_book
  (provider, model, input_micro_usd_per_mtoken, cached_input_micro_usd_per_mtoken,
   output_micro_usd_per_mtoken, reasoning_micro_usd_per_mtoken, source, source_url, fetched_at)
VALUES
  ('openai', 'gpt-5-mini', 250000, 25000, 2000000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://openai.com/api/pricing/', now()),
  ('openai', 'gpt-5', 1250000, 125000, 10000000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://openai.com/api/pricing/', now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;
