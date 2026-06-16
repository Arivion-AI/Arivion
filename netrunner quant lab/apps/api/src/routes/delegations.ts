import express from "express";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";

// EIP-7710 delegation store. The user signs a scoped root delegation to an agent account (the
// orchestrator) in the browser via MetaMask; this records it so the backend can later encode it
// into a `permissionContext` and redeem it on-chain through the 1Shot relayer (W5). Storing a
// signed delegation is the security upgrade — the agent never holds the user's keys, only a
// caveated grant. All owner-scoped via requireOwnerId.

type Hexish = string;

function isHexAddress(s: unknown): s is Hexish {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function createDelegationsRouter(): express.Router {
  const router = express.Router();

  // Record a signed delegation (root, from the user; or a redelegation with parentId).
  // body: { delegateAddress, chainId, signedDelegation, scope?, caveats?, authorization?, parentId?, expiresAt? }
  router.post("/api/delegations", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const chainId = Number(b.chainId);
      if (!Number.isInteger(chainId) || chainId <= 0) return res.status(400).json({ error: "BAD_CHAIN_ID" });
      const parentId = typeof b.parentId === "string" ? b.parentId : null;
      const expiresAt = b.expiresAt ? new Date(String(b.expiresAt)) : null;
      const id = `del_${randomUUID()}`;

      let delegateAddress: string | undefined;
      let delegatorAddress: string | undefined;
      let storedSigned: unknown; // goes into signed_delegation JSONB (Delegation7710 OR an erc7715 grant wrapper)

      if (b.grantType === "erc7715") {
        // ERC-7715 Advanced Permissions grant (wallet_grantPermissions). The "signed delegation" is the
        // opaque permission context + its delegationManager + counterfactual SA dependencies.
        const context = b.permissionContext;
        if (typeof context !== "string" || !context.startsWith("0x")) return res.status(400).json({ error: "MISSING_PERMISSION_CONTEXT" });
        delegateAddress = isHexAddress(b.delegateAddress) ? b.delegateAddress : undefined;
        delegatorAddress = isHexAddress(b.delegatorAddress) ? b.delegatorAddress : undefined;
        if (!isHexAddress(delegateAddress)) return res.status(400).json({ error: "BAD_DELEGATE_ADDRESS" });
        if (!isHexAddress(delegatorAddress)) return res.status(400).json({ error: "BAD_DELEGATOR_ADDRESS" });
        storedSigned = { grantType: "erc7715", context, delegationManager: b.delegationManager, dependencies: b.dependencies };
      } else {
        // ERC-7710 signed delegation (struct with a signature).
        const signed = b.signedDelegation as { delegate?: string; delegator?: string; signature?: string } | undefined;
        if (!signed || typeof signed !== "object") return res.status(400).json({ error: "MISSING_SIGNED_DELEGATION" });
        if (!signed.signature) return res.status(400).json({ error: "DELEGATION_NOT_SIGNED" });
        delegateAddress = isHexAddress(b.delegateAddress) ? b.delegateAddress : signed.delegate;
        delegatorAddress = signed.delegator;
        if (!isHexAddress(delegateAddress)) return res.status(400).json({ error: "BAD_DELEGATE_ADDRESS" });
        if (!isHexAddress(delegatorAddress)) return res.status(400).json({ error: "BAD_DELEGATOR_ADDRESS" });
        storedSigned = signed;
      }

      // One active delegation per (owner, delegate, chain): retire any prior active link first so the
      // partial unique index never collides (re-authorizing replaces the old grant).
      await db.query(
        `UPDATE agent_delegations SET status='revoked', updated_at=now()
           WHERE owner_id=$1 AND lower(delegate_address)=lower($2) AND chain_id=$3 AND status='active'`,
        [owner, delegateAddress, chainId],
      );
      await db.query(
        `INSERT INTO agent_delegations
           (id, owner_id, parent_id, delegator_address, delegate_address, chain_id,
            signed_delegation, scope, caveats, eip7702_auth, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, owner, parentId, delegatorAddress, delegateAddress, chainId,
         JSON.stringify(storedSigned), b.scope != null ? JSON.stringify(b.scope) : null,
         b.caveats != null ? JSON.stringify(b.caveats) : null,
         b.authorization != null ? JSON.stringify(b.authorization) : null, expiresAt],
      );
      res.json({ ok: true, id, delegateAddress, delegatorAddress, chainId, grantType: b.grantType === "erc7715" ? "erc7715" : "erc7710", status: "active" });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // List the owner's delegations (active first). Used by the WalletDock to show authorization status.
  router.get("/api/delegations", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const r = await db.query(
        `SELECT id, parent_id, delegator_address, delegate_address, chain_id, scope, caveats,
                status, expires_at, created_at
           FROM agent_delegations WHERE owner_id=$1 ORDER BY (status='active') DESC, created_at DESC LIMIT 100`,
        [owner],
      );
      res.json({ ok: true, delegations: r.rows });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  // Revoke a delegation (owner-scoped). The on-chain enforcement still relies on caveats/expiry, but
  // this stops the backend from redeeming it.
  router.post("/api/delegations/:id/revoke", async (req, res) => {
    try {
      const owner = requireOwnerId(req);
      const r = await db.query(
        `UPDATE agent_delegations SET status='revoked', updated_at=now()
           WHERE id=$1 AND owner_id=$2 AND status='active' RETURNING id`,
        [req.params.id, owner],
      );
      if (!r.rowCount) return res.status(404).json({ error: "NOT_FOUND_OR_INACTIVE" });
      res.json({ ok: true, id: req.params.id, status: "revoked" });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
