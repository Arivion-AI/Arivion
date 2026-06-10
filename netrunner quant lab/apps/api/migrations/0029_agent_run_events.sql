-- 0029: Durable Copilot run event replay.
-- The SSE bus remains the live transport, but every emitted event is also written here so old
-- threads can hydrate the Nexa board, trace rail, questions, truth cards, and terminal state.

CREATE TABLE IF NOT EXISTS agent_run_events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES agent_threads(id) ON DELETE CASCADE,
  owner_id    BIGINT NOT NULL REFERENCES users(id),
  seq         INT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB,
  emitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS agent_run_events_run_idx
  ON agent_run_events(run_id, seq ASC);

CREATE INDEX IF NOT EXISTS agent_run_events_thread_idx
  ON agent_run_events(owner_id, thread_id, emitted_at ASC, id ASC);
