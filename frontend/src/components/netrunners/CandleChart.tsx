"use client";

import { useEffect, useRef } from "react";
import {
  createChart, CandlestickSeries, HistogramSeries, ColorType,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import type { CandleBar } from "@/lib/netrunners/api";

// Serious-trading candlestick + volume chart (TradingView's lightweight-charts v5), themed to the
// netrunners orange/teal/red palette. Replaces the old line-only SparkAreaChart.
export function CandleChart({ bars, height = 340 }: { bars: CandleBar[]; height?: number }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8a90c0", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)" },
      grid: { vertLines: { color: "rgba(138,144,192,0.06)" }, horzLines: { color: "rgba(138,144,192,0.08)" } },
      rightPriceScale: { borderColor: "rgba(138,144,192,0.18)" },
      timeScale: { borderColor: "rgba(138,144,192,0.18)", timeVisible: false, secondsVisible: false },
      crosshair: { mode: 1, vertLine: { color: "rgba(239,90,35,0.5)", labelBackgroundColor: "#ef5a23" }, horzLine: { color: "rgba(239,90,35,0.5)", labelBackgroundColor: "#ef5a23" } },
    });
    chartRef.current = chart;
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#16e0b0", downColor: "#ff3b53", borderUpColor: "#16e0b0", borderDownColor: "#ff3b53", wickUpColor: "#16e0b0", wickDownColor: "#ff3b53",
    });
    volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    return () => { chart.remove(); chartRef.current = null; candleRef.current = null; volRef.current = null; };
  }, []);

  useEffect(() => {
    const candle = candleRef.current, vol = volRef.current, chart = chartRef.current;
    if (!candle || !vol || !chart) return;
    // lightweight-charts requires strictly-ascending, unique timestamps.
    const seen = new Set<number>();
    const clean = bars
      .map((b) => ({ t: Number(b.ts), o: Number(b.open), h: Number(b.high), l: Number(b.low), c: Number(b.close), v: Number(b.volume) || 0 }))
      .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.c) && d.c > 0)
      .sort((a, b) => a.t - b.t)
      .filter((d) => (seen.has(d.t) ? false : (seen.add(d.t), true)));
    candle.setData(clean.map((d) => ({ time: d.t as UTCTimestamp, open: d.o, high: d.h, low: d.l, close: d.c })));
    vol.setData(clean.map((d) => ({ time: d.t as UTCTimestamp, value: d.v, color: d.c >= d.o ? "rgba(22,224,176,0.35)" : "rgba(255,59,83,0.35)" })));
    chart.timeScale().fitContent();
  }, [bars]);

  return <div ref={elRef} style={{ width: "100%", height }} />;
}
