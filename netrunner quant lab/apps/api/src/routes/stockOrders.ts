import express from "express";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";
import { executionEnabled } from "../lib/agentExec.js";

// Limit orders, baskets, and DCA bots over the tokenized-stock vault. Persisted here; FILLED by the
// always-on stock order engine. All owner-scoped via requireOwnerId.

const norm = (s: unknown): string => String(s ?? "").trim().toUpperCase().replace(/^D(?=[A-Z]{2,6}$)/, "");

type LegIn = { symbol?: unknown; usdg?: unknown; stock?: unknown };

export function createStockOrdersRouter(): express.Router {
  const router = express.Router();

  router.get("/api/exec/orders", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const [orders, bots, events] = await Promise.all([
        db.query(`SELECT * FROM stock_orders WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`, [owner]),
        db.query(`SELECT * FROM stock_dca_bots WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`, [owner]),
        db.query(`SELECT * FROM stock_order_events WHERE owner_id=$1 ORDER BY ts DESC LIMIT 60`, [owner]),
      ]);
      res.json({ ok: true, executionEnabled: executionEnabled(), orders: orders.rows, bots: bots.rows, events: events.rows });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // Create a limit order or a basket. body: { kind?, side?, legs:[{symbol, usdg?|stock?}], triggerPrice?, comparator?, expiresInSec?, createdBy?, runId? }
  router.post("/api/exec/orders", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const side = b.side === "sell" ? "sell" : "buy";
      const legs = (Array.isArray(b.legs) ? (b.legs as LegIn[]) : [])
        .map((l) => ({ symbol: norm(l.symbol), usdg: l.usdg != null ? Number(l.usdg) : undefined, stock: l.stock != null ? Number(l.stock) : undefined }))
        .filter((l) => l.symbol && ((l.usdg ?? 0) > 0 || (l.stock ?? 0) > 0));
      if (!legs.length) return res.status(400).json({ ok: false, error: "NO_LEGS" });
      const kind = b.kind === "basket" || legs.length > 1 ? "basket" : "limit";
      const triggerPrice1e8 = b.triggerPrice != null ? Math.round(Number(b.triggerPrice) * 1e8) : null;
      const comparator = triggerPrice1e8 != null ? (b.comparator === "gte" ? "gte" : side === "sell" ? "gte" : "lte") : null;
      const triggerSymbol = triggerPrice1e8 != null ? legs[0].symbol : null;
      const expiresAt = b.expiresInSec ? new Date(Date.now() + Number(b.expiresInSec) * 1000) : null;
      const id = `ord_${randomUUID()}`;
      await db.query(
        `INSERT INTO stock_orders (id, owner_id, kind, side, legs, trigger_price_1e8, comparator, trigger_symbol, created_by, run_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, owner, kind, side, JSON.stringify(legs), triggerPrice1e8, comparator, triggerSymbol,
         b.createdBy === "copilot" ? "copilot" : "user", b.runId ?? null, expiresAt],
      );
      res.json({
        ok: true, id, kind, side, legs,
        triggerPriceUsd: triggerPrice1e8 != null ? triggerPrice1e8 / 1e8 : null, comparator,
        note: triggerPrice1e8 == null
          ? "Fills on the next engine tick (~30s)."
          : `Pending until ${triggerSymbol} oracle price is ${comparator === "gte" ? "≥" : "≤"} $${(triggerPrice1e8 / 1e8).toFixed(2)}.`,
      });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  router.delete("/api/exec/orders/:id", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const r = await db.query(`UPDATE stock_orders SET state='cancelled', updated_at=now() WHERE id=$1 AND owner_id=$2 AND state='pending' RETURNING id`, [req.params.id, owner]);
      res.json({ ok: (r.rowCount ?? 0) > 0 });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  // Create a DCA bot. body: { legs:[{symbol, usdg}], intervalSeconds, maxRuns?, startNow?, createdBy?, runId? }
  router.post("/api/exec/dca", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const legs = (Array.isArray(b.legs) ? (b.legs as LegIn[]) : [])
        .map((l) => ({ symbol: norm(l.symbol), usdg: Number(l.usdg ?? 0) }))
        .filter((l) => l.symbol && l.usdg > 0);
      if (!legs.length) return res.status(400).json({ ok: false, error: "NO_LEGS" });
      const interval = Math.max(60, Number(b.intervalSeconds ?? 86400));
      const usdgPerRun = legs.reduce((s, l) => s + l.usdg, 0);
      const next = b.startNow === false ? new Date(Date.now() + interval * 1000) : new Date();
      const id = `dca_${randomUUID()}`;
      await db.query(
        `INSERT INTO stock_dca_bots (id, owner_id, legs, side, usdg_per_run, interval_seconds, next_run_at, max_runs, created_by, run_id)
         VALUES ($1,$2,$3,'buy',$4,$5,$6,$7,$8,$9)`,
        [id, owner, JSON.stringify(legs), usdgPerRun, interval, next, b.maxRuns != null ? Number(b.maxRuns) : null,
         b.createdBy === "copilot" ? "copilot" : "user", b.runId ?? null],
      );
      res.json({ ok: true, id, legs, intervalSeconds: interval, usdgPerRun, maxRuns: b.maxRuns ?? null });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  router.patch("/api/exec/dca/:id", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const state = (req.body as Record<string, unknown>)?.action === "resume" ? "active" : "paused";
      const r = await db.query(`UPDATE stock_dca_bots SET state=$3, updated_at=now() WHERE id=$1 AND owner_id=$2 AND state IN ('active','paused') RETURNING state`, [req.params.id, owner, state]);
      res.json({ ok: (r.rowCount ?? 0) > 0, state: r.rows[0]?.state });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  router.delete("/api/exec/dca/:id", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const r = await db.query(`UPDATE stock_dca_bots SET state='done', updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING id`, [req.params.id, owner]);
      res.json({ ok: (r.rowCount ?? 0) > 0 });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
  });

  return router;
}
