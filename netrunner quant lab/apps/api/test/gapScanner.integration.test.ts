import { beforeAll, afterAll, describe, expect, test } from "vitest";
import pg from "pg";
import { scanCoverage } from "../src/lib/gapScanner.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const runIntegration = Boolean(databaseUrl);

const describeIf = runIntegration ? describe : describe.skip;

let pool: pg.Pool;

const symbol = "BTCUSDT";
const category = "linear";
const interval = "15";
const startTs = Date.UTC(2026, 0, 1, 0, 0, 0);

beforeAll(async () => {
  if (!databaseUrl) {
    return;
  }

  pool = new Pool({ connectionString: databaseUrl });

  const rows = Array.from({ length: 10 }).map((_, i) => {
    const ts = new Date(startTs + i * 15 * 60_000).toISOString();
    return `('${symbol}','${category}','${interval}','${ts}',100,101,99,100.5,10,1000,'test-v1','seed-${i}')`;
  });

  await pool.query(
    `
      INSERT INTO candles (
        symbol, category, interval, open_time, open, high, low, close, volume, turnover, data_version, checksum
      ) VALUES ${rows.join(",")}
      ON CONFLICT (symbol, category, interval, open_time) DO NOTHING
    `
  );
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
});

describeIf("gap scanner + backtest gate", () => {
  test("flags missing candle range and would block backtest", async () => {
    if (!pool) {
      return;
    }

    const holeStart = new Date(startTs + 3 * 15 * 60_000).toISOString();
    const holeEnd = new Date(startTs + 5 * 15 * 60_000).toISOString();
    await pool.query(
      `
        DELETE FROM candles
        WHERE symbol = $1
          AND category = $2
          AND interval = $3
          AND open_time BETWEEN $4::timestamptz AND $5::timestamptz
      `,
      [symbol, category, interval, holeStart, holeEnd]
    );

    const result = await scanCoverage({
      symbol,
      category,
      interval,
      startTs,
      endTs: startTs + 9 * 15 * 60_000
    });

    expect(result.missingBars).toBeGreaterThan(0);
    expect(result.missingRanges.length).toBeGreaterThan(0);
  });
});
