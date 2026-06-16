-- 0032: Price-book rows for Venice AI models (the Copilot's primary brain after the port).
-- A managed call with no ACTIVE price row is BLOCKED by design (see llm-gateway/index.ts
-- NO_ACTIVE_PRICE), so the configured VENICE_MODEL (default mistral-small-3-2-24b-instruct) needs a
-- row here or new owners silently fall back to another managed provider. Model IDs below were verified against the
-- LIVE catalog (GET https://api.venice.ai/api/v1/models?type=text) on 2026-06-15 — all report
-- capabilities.supportsFunctionCalling=true. Costs are micro-USD per million tokens, marked
-- UNVERIFIED placeholders (same convention as 0014/0026) — verify against Venice's live pricing
-- (https://docs.venice.ai) before production billing. If you set VENICE_MODEL to a model not listed
-- here, add its price row too.
INSERT INTO agent_model_price_book
  (provider, model, input_micro_usd_per_mtoken, cached_input_micro_usd_per_mtoken,
   output_micro_usd_per_mtoken, reasoning_micro_usd_per_mtoken, source, source_url, fetched_at)
VALUES
  -- Lightweight default.
  ('venice', 'mistral-small-3-2-24b-instruct', 200000, NULL, 600000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://docs.venice.ai', now()),
  -- Cheaper flash alternative.
  ('venice', 'zai-org-glm-4.7-flash', 150000, NULL, 600000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://docs.venice.ai', now()),
  -- Heavier fallbacks for planner-escalation.
  ('venice', 'llama-3.3-70b', 700000, NULL, 2800000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://docs.venice.ai', now()),
  ('venice', 'qwen3-235b-a22b-instruct-2507', 1500000, NULL, 6000000, NULL,
     'SEED_PLACEHOLDER_UNVERIFIED', 'https://docs.venice.ai', now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;
