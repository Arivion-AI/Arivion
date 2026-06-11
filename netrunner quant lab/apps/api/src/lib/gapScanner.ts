import { db } from "./db.js";
import { alignTsToInterval, intervalToMs } from "./interval.js";

export type GapScanInput = {
  symbol: string;
  category: string;
  interval: string;
  startTs: number;
  endTs: number;
};

export type GapScanResult = {
  expectedBars: number;
  actualBars: number;
  duplicateBars: number;
  missingBars: number;
  missingRanges: Array<{ startTs: number; endTs: number }>;
};

export async function scanCoverage(input: GapScanInput): Promise<GapScanResult> {
  const step = intervalToMs(input.interval);
  const alignedStartTs = alignTsToInterval(input.startTs, input.interval);
  const alignedEndTs = alignTsToInterval(input.endTs, input.interval);
  const query = `
    SELECT open_time
    FROM candles
    WHERE symbol = $1
      AND category = $2
      AND interval = $3
      AND open_time BETWEEN to_timestamp($4 / 1000.0) AND to_timestamp($5 / 1000.0)
    ORDER BY open_time ASC
  `;

  const rows = await db.query<{ open_time: Date }>(query, [
    input.symbol,
    input.category,
    input.interval,
    alignedStartTs,
    alignedEndTs
  ]);

  const expectedBars = Math.max(0, Math.floor((alignedEndTs - alignedStartTs) / step) + 1);
  const tsValues = rows.rows.map((r: { open_time: Date }) => r.open_time.getTime());
  const seen = new Set<number>();
  let duplicateBars = 0;

  for (const ts of tsValues) {
    if (seen.has(ts)) {
      duplicateBars += 1;
      continue;
    }
    seen.add(ts);
  }

  const missingRanges: Array<{ startTs: number; endTs: number }> = [];
  let rangeStart: number | null = null;
  let prevMissing: number | null = null;

  for (let expectedTs = alignedStartTs; expectedTs <= alignedEndTs; expectedTs += step) {
    if (!seen.has(expectedTs)) {
      if (rangeStart === null) {
        rangeStart = expectedTs;
      }
      prevMissing = expectedTs;
      continue;
    }

    if (rangeStart !== null && prevMissing !== null) {
      missingRanges.push({ startTs: rangeStart, endTs: prevMissing });
      rangeStart = null;
      prevMissing = null;
    }
  }

  if (rangeStart !== null && prevMissing !== null) {
    missingRanges.push({ startTs: rangeStart, endTs: prevMissing });
  }

  return {
    expectedBars,
    actualBars: seen.size,
    duplicateBars,
    missingBars: Math.max(0, expectedBars - seen.size),
    missingRanges
  };
}

export async function upsertCoverageRow(input: GapScanInput, dataVersion: string): Promise<GapScanResult> {
  const result = await scanCoverage(input);
  await db.query(
    `
      INSERT INTO data_coverage (
        symbol, category, interval, range_start, range_end,
        expected_bars, actual_bars, missing_bars, duplicate_bars,
        data_version, subject_to_retention, updated_at
      ) VALUES (
        $1, $2, $3,
        to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0),
        $6, $7, $8, $9,
        $10, false, NOW()
      )
      ON CONFLICT (symbol, category, interval, range_start, range_end, data_version)
      DO UPDATE SET
        expected_bars = EXCLUDED.expected_bars,
        actual_bars = EXCLUDED.actual_bars,
        missing_bars = EXCLUDED.missing_bars,
        duplicate_bars = EXCLUDED.duplicate_bars,
        updated_at = NOW()
    `,
    [
      input.symbol,
      input.category,
      input.interval,
      input.startTs,
      input.endTs,
      result.expectedBars,
      result.actualBars,
      result.missingBars,
      result.duplicateBars,
      dataVersion
    ]
  );
  return result;
}
