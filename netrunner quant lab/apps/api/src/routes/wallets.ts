import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { formatUnits, getAddress, verifyMessage } from "ethers";
import type { Redis as RedisClient } from "ioredis";
import { z } from "zod";
import { db } from "../lib/db.js";
import { requireOwnerId } from "../lib/auth.js";
import { findChain, publicChain } from "../config/chains.js";

const NONCE_TTL_SECONDS = 10 * 60;
const BALANCE_OF_SELECTOR = "0x70a08231";

function hashMessage(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

function nonceKey(ownerId: number, address: string, chainId: number, nonce: string): string {
  return `wallet-link:${ownerId}:${chainId}:${address.toLowerCase()}:${nonce}`;
}

function normalizeAddress(address: string): string {
  return getAddress(address.trim());
}

function encodeBalanceOf(address: string): string {
  return `${BALANCE_OF_SELECTOR}${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(7000),
  });
  const body = await response.json() as { result?: string; error?: { message?: string } };
  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `RPC_${response.status}`);
  }
  return body.result ?? "0x0";
}

export function createWalletsRouter(redis: RedisClient): express.Router {
  const router = express.Router();

  router.get("/api/wallets", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const r = await db.query(
      `
        SELECT wl.wallet_address, wl.chain_id, c.name AS chain_name, wl.verified_at, wl.label, wl.metadata_json
        FROM wallet_links wl
        JOIN chains c ON c.chain_id = wl.chain_id
        WHERE wl.owner_id = $1
        ORDER BY wl.verified_at DESC
      `,
      [ownerId]
    );
    res.json({ wallets: r.rows });
  });

  router.post("/api/wallets/nonce", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const parsed = z.object({
      walletAddress: z.string().optional(),
      address: z.string().optional(),
      chainId: z.number().int(),
      label: z.string().optional(),
    }).refine((value) => Boolean(value.walletAddress || value.address), { message: "walletAddress or address is required" }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const chain = findChain(parsed.data.chainId);
    if (!chain || !chain.isTestnet) return res.status(400).json({ error: "WALLET_CHAIN_NOT_TESTNET_SUPPORTED" });
    let address: string;
    try {
      address = normalizeAddress(parsed.data.walletAddress ?? parsed.data.address ?? "");
    } catch {
      return res.status(400).json({ error: "INVALID_WALLET_ADDRESS" });
    }
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + NONCE_TTL_SECONDS * 1000).toISOString();
    const message = [
      `Duality wallet link for owner_id ${ownerId}`,
      `wallet ${address}`,
      `chain_id ${chain.chainId}`,
      `nonce ${nonce}`,
      `expires ${expiresAt}`,
      "This proves wallet ownership for testnet-only actions. It does not authorize real-money trading.",
    ].join("\n");
    await redis.set(nonceKey(ownerId, address, chain.chainId, nonce), JSON.stringify({ message, label: parsed.data.label ?? null }), "EX", NONCE_TTL_SECONDS);
    res.json({ walletAddress: address, chain: publicChain(chain), nonce, message, expiresAt });
  });

  router.post("/api/wallets/verify", async (req, res) => {
    const ownerId = requireOwnerId(req);
    const parsed = z.object({
      walletAddress: z.string().optional(),
      address: z.string().optional(),
      chainId: z.number().int(),
      nonce: z.string().optional(),
      message: z.string().optional(),
      signature: z.string(),
      label: z.string().optional(),
    }).refine((value) => Boolean(value.walletAddress || value.address), { message: "walletAddress or address is required" })
      .refine((value) => Boolean(value.nonce || value.message), { message: "nonce or message is required" })
      .safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const chain = findChain(parsed.data.chainId);
    if (!chain || !chain.isTestnet) return res.status(400).json({ error: "WALLET_CHAIN_NOT_TESTNET_SUPPORTED" });
    let address: string;
    try {
      address = normalizeAddress(parsed.data.walletAddress ?? parsed.data.address ?? "");
    } catch {
      return res.status(400).json({ error: "INVALID_WALLET_ADDRESS" });
    }
    const nonce = parsed.data.nonce ?? parsed.data.message?.match(/^nonce ([a-f0-9]+)$/m)?.[1];
    if (!nonce) return res.status(400).json({ error: "WALLET_NONCE_MISSING" });
    const key = nonceKey(ownerId, address, chain.chainId, nonce);
    const raw = await redis.get(key);
    if (!raw) return res.status(400).json({ error: "WALLET_NONCE_EXPIRED_OR_UNKNOWN" });
    const stored = JSON.parse(raw) as { message: string; label?: string | null };
    if (parsed.data.message && parsed.data.message !== stored.message) {
      return res.status(400).json({ error: "WALLET_MESSAGE_MISMATCH" });
    }
    let recovered: string;
    try {
      recovered = normalizeAddress(verifyMessage(parsed.data.message ?? stored.message, parsed.data.signature));
    } catch {
      return res.status(400).json({ error: "WALLET_SIGNATURE_INVALID" });
    }
    if (recovered !== address) {
      return res.status(403).json({ error: "WALLET_SIGNATURE_ADDRESS_MISMATCH", recovered });
    }
    await db.query(
      `
        INSERT INTO wallet_links (owner_id, wallet_address, chain_id, verified_at, proof_message_hash, label, metadata_json)
        VALUES ($1,$2,$3,NOW(),$4,$5,$6::jsonb)
        ON CONFLICT (owner_id, wallet_address, chain_id)
        DO UPDATE SET verified_at = NOW(), proof_message_hash = EXCLUDED.proof_message_hash,
                      label = EXCLUDED.label, metadata_json = EXCLUDED.metadata_json
      `,
      [
        ownerId,
        address,
        chain.chainId,
        hashMessage(stored.message),
        parsed.data.label ?? stored.label ?? null,
        JSON.stringify({ signature_type: "eip191", testnet_only: true }),
      ]
    );
    await redis.del(key);
    res.json({ ok: true, walletAddress: address, wallet: { wallet_address: address, chain_id: chain.chainId }, chain: publicChain(chain), verified: true });
  });

  router.delete("/api/wallets/:address", async (req, res) => {
    const ownerId = requireOwnerId(req);
    let address: string;
    try {
      address = normalizeAddress(req.params.address);
    } catch {
      return res.status(400).json({ error: "INVALID_WALLET_ADDRESS" });
    }
    const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
    const params: unknown[] = [ownerId, address];
    const chainFilter = chainId ? `AND chain_id = $3` : "";
    if (chainId) params.push(chainId);
    const r = await db.query(
      `DELETE FROM wallet_links WHERE owner_id = $1 AND wallet_address = $2 ${chainFilter} RETURNING wallet_address, chain_id`,
      params
    );
    res.json({ ok: true, removed: r.rows });
  });

  router.get("/api/wallets/:address/balances", async (req, res) => {
    const ownerId = requireOwnerId(req);
    let address: string;
    try {
      address = normalizeAddress(req.params.address);
    } catch {
      return res.status(400).json({ error: "INVALID_WALLET_ADDRESS" });
    }
    const chainId = Number(req.query.chainId);
    const chain = findChain(chainId);
    if (!chain) return res.status(404).json({ error: "CHAIN_NOT_FOUND" });
    if (!chain.rpcUrl) return res.status(503).json({ error: "CHAIN_RPC_NOT_CONFIGURED", chain: publicChain(chain) });
    const linked = await db.query(
      `SELECT 1 FROM wallet_links WHERE owner_id = $1 AND wallet_address = $2 AND chain_id = $3 LIMIT 1`,
      [ownerId, address, chainId]
    );
    if (!linked.rowCount) return res.status(403).json({ error: "WALLET_NOT_LINKED_FOR_OWNER" });

    const tokenRows = await db.query(
      `
        SELECT address, symbol, name, decimals, asset_class, is_testnet_asset, underlying_symbol, metadata_json
        FROM token_registry
        WHERE chain_id = $1
        ORDER BY asset_class, symbol
      `,
      [chainId]
    );
    const balances: Array<Record<string, unknown>> = [];
    try {
      const nativeRaw = BigInt(await rpcCall(chain.rpcUrl, "eth_getBalance", [address, "latest"]));
      balances.push({
        chain_id: chainId,
        address: null,
        symbol: chain.nativeCurrency.symbol,
        name: `${chain.nativeCurrency.symbol} native`,
        balance_raw: nativeRaw.toString(),
        balance: formatUnits(nativeRaw, chain.nativeCurrency.decimals),
        asset_class: "native",
        is_testnet_asset: chain.isTestnet,
      });
    } catch (error) {
      balances.push({ symbol: chain.nativeCurrency.symbol, error: (error as Error).message, asset_class: "native" });
    }
    for (const token of tokenRows.rows) {
      try {
        const result = await rpcCall(chain.rpcUrl, "eth_call", [{ to: token.address, data: encodeBalanceOf(address) }, "latest"]);
        const raw = BigInt(result);
        balances.push({
          chain_id: chainId,
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          balance_raw: raw.toString(),
          balance: formatUnits(raw, Number(token.decimals ?? 18)),
          decimals: Number(token.decimals ?? 18),
          asset_class: token.asset_class,
          is_testnet_asset: token.is_testnet_asset,
          underlying_symbol: token.underlying_symbol,
          metadata_json: token.metadata_json,
        });
      } catch (error) {
        balances.push({
          chain_id: chainId,
          address: token.address,
          symbol: token.symbol,
          error: (error as Error).message,
          asset_class: token.asset_class,
          is_testnet_asset: token.is_testnet_asset,
        });
      }
    }
    res.json({
      walletAddress: address,
      chain: publicChain(chain),
      balances,
      truth: {
        data_source: "testnet_rpc",
        testnet_disclaimer: chain.isTestnet ? "Balances are testnet assets only and do not represent production value." : null,
        can_execute_real_money: false,
      },
    });
  });

  return router;
}
