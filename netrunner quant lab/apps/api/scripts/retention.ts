/**
 * §25 P3 — retention for user-linked behavioral data.
 *
 * Recon found NO retention on backtest_runs/events, live_paper_sessions/checkpoints, paper_fills —
 * they persisted indefinitely (only L2/trades had 7-day retention). This job ages them out beyond a
 * configurable window. Idempotent; safe to run on a cron. Market-data tables are out of scope here.
 *
 * Run: BEHAVIORAL_RETENTION_DAYS=365 tsx scripts/retention.ts
 * (A Timescale `add_retention_policy` is preferable for the hypertable-backed ones once enabled;
 *  this explicit job is the portable baseline and also covers plain tables.)
 */
import { db } from "../src/lib/db.js";

const DAYS = Number(process.env.BEHAVIORAL_RETENTION_DAYS ?? 365);

async function run(): Promise<void> {
  const cutoffSql = `NOW() - INTERVAL '${Number.isFinite(DAYS) && DAYS > 0 ? DAYS : 365} days'`;
  // Children first, then parents (no ON DELETE CASCADE today).
  const steps: Array<[string, string]> = [
    ["backtest_events", `DELETE FROM backtest_events WHERE run_id IN (SELECT run_id FROM backtest_runs WHERE created_at < ${cutoffSql})`],
    ["risk_snapshots", `DELETE FROM risk_snapshots WHERE run_id IN (SELECT run_id FROM backtest_runs WHERE created_at < ${cutoffSql})`],
    ["backtest_runs", `DELETE FROM backtest_runs WHERE created_at < ${cutoffSql}`],
    ["live_paper_checkpoints", `DELETE FROM live_paper_checkpoints WHERE created_at < ${cutoffSql}`],
    ["live_paper_sessions", `DELETE FROM live_paper_sessions WHERE created_at < ${cutoffSql}`],
    ["paper_fills", `DELETE FROM paper_fills WHERE ts < ${cutoffSql}`],
  ];
  for (const [name, sql] of steps) {
    try {
      const r = await db.query(sql);
      // eslint-disable-next-line no-console
      console.log(`retention: ${name} removed ${r.rowCount ?? 0} rows older than ${DAYS}d`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`retention: ${name} skipped (${(error as Error).message})`);
    }
  }
  await db.end();
  // eslint-disable-next-line no-console
  console.log("retention complete");
}

run().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  await db.end();
  process.exit(1);
});
