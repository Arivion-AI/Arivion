export const dynamic = "force-dynamic";

// GMX funding is fetched live by GET /api/gmx/funding (no backing table to backfill), so "ensure"
// is a success no-op kept for symmetry with /api/candles/ensure. It exists so the client helper's
// ensure-then-refetch path resolves cleanly instead of 404-ing.
export async function POST(): Promise<Response> {
  return Response.json({ ok: true, source: "gmx_snapshot_projected", note: "GMX funding is served live; nothing to backfill." });
}
