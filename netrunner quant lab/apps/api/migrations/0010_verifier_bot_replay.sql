-- 0010: P0.2 — verifier replays the SAME engine that produced the run.
-- Bot/algo runs are produced by PaperRuntime (run_bot); their event stream embeds order IDs from
-- a process-global counter, so the RAW event_digest is not reproducible across processes (worker
-- vs verifier). We persist a cross-process-stable canonical digest (order IDs canonicalized to a
-- per-run sequence) that the verifier reproduces by replaying PaperRuntime. NULL for legacy runs
-- and for simple EventBacktestEngine runs (whose raw digest is already reproducible).

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS canonical_event_digest TEXT;
