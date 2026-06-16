// Agent on-chain execution (TESTNET ONLY). The agent signs + sends real transactions with a backend
// wallet — this is where a "launched" plan stops simulating and acts on-chain. Phase 1: the stock-buy
// vertical on Robinhood Chain testnet (46630), which is fully deployed (DualityStockVault + MockUSDG +
// oracle keeper). Per-user wallets layer on top later; for now one backend agent wallet executes.
//
// Hard guardrails: testnet chains only (46630 / 421614), an env kill-switch, and a per-tx USD cap.
import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from "ethers";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { boolEnv } from "../config/chains.js";
import { db } from "./db.js";
import { readChainlinkMany, readStockFeedMany, chainlinkReference } from "./chainlink.js";

const RH_CHAIN_ID = 46630;
const LAUNCH_CAP_USD = 20;
const MAX_BUY_USDG = Number(process.env.AGENT_MAX_BUY_USDG ?? 2000); // per-tx cap (testnet safety)
const GAS_TOPUP = process.env.AGENT_GAS_TOPUP_ETH ?? "0.004"; // gas funded to each new user wallet/chain

function rhProvider(): JsonRpcProvider {
  const url = process.env.ROBINHOOD_TESTNET_ALCHEMY_RPC_URL || process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
  return new JsonRpcProvider(url, RH_CHAIN_ID, { staticNetwork: true });
}

// Treasury = the deployer wallet; funds gas into per-user wallets and owns the stock vault/oracle.
function treasury(provider: JsonRpcProvider): Wallet {
  const pk = process.env.DEPLOY_PRIVATE_KEY;
  if (!pk) throw new Error("TREASURY_NOT_CONFIGURED");
  return new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
}

// --- Per-user agent wallets (encrypted at rest; auto gas-funded from treasury) ---
const ENC_KEY = createHash("sha256").update(process.env.AGENT_WALLET_MASTER_KEY ?? "REDACTED_AGENT_WALLET_MASTER_KEY").digest();
function encPk(pk: string): string {
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const e = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), e.toString("hex")].join(":");
}
function decPk(s: string): string {
  const [iv, tag, e] = s.split(":");
  const d = createDecipheriv("aes-256-gcm", ENC_KEY, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(e, "hex")), d.final()]).toString("utf8");
}

/** Each owner gets their own EOA the agent signs with. Created lazily, encrypted in DB, and topped up
 *  with a little gas from the treasury on the chain being used (so a fresh wallet can transact). */
async function getOrCreateWallet(ownerId: number, provider: JsonRpcProvider): Promise<Wallet> {
  const row = await db.query("SELECT address, enc_privkey, funded_arb, funded_rh FROM agent_wallets WHERE owner_id=$1", [ownerId]);
  let pk: string, address: string, fundedArb = false, fundedRh = false;
  if (row.rowCount) {
    pk = decPk(row.rows[0].enc_privkey); address = row.rows[0].address;
    fundedArb = row.rows[0].funded_arb; fundedRh = row.rows[0].funded_rh;
  } else {
    const w = Wallet.createRandom(); pk = w.privateKey; address = w.address;
    await db.query("INSERT INTO agent_wallets (owner_id, address, enc_privkey) VALUES ($1,$2,$3) ON CONFLICT (owner_id) DO NOTHING", [ownerId, address, encPk(pk)]);
  }
  const net = await provider.getNetwork();
  const isArb = Number(net.chainId) === ARB_SEPOLIA_CHAIN_ID;
  const alreadyFunded = isArb ? fundedArb : fundedRh;
  if (!alreadyFunded) {
    const bal = await provider.getBalance(address);
    if (bal < parseEther(GAS_TOPUP)) {
      try {
        const tx = await treasury(provider).sendTransaction({ to: address, value: parseEther(GAS_TOPUP) });
        await tx.wait();
      } catch { /* treasury low / best-effort; wallet may still have gas */ }
    }
    await db.query(`UPDATE agent_wallets SET ${isArb ? "funded_arb" : "funded_rh"}=TRUE WHERE owner_id=$1`, [ownerId]);
  }
  return new Wallet(pk, provider);
}

// Owner's agent-wallet address + raw key (no provider, no gas funding) — used to sign GMX-live orders
// on Arbitrum One with the SAME per-user wallet the rest of the app uses (one account to fund).
export async function agentWalletKey(ownerId: number): Promise<{ address: string; privateKey: string }> {
  const row = await db.query("SELECT address, enc_privkey FROM agent_wallets WHERE owner_id=$1", [ownerId]);
  if (row.rowCount) return { address: row.rows[0].address as string, privateKey: decPk(row.rows[0].enc_privkey as string) };
  const w = Wallet.createRandom();
  await db.query("INSERT INTO agent_wallets (owner_id, address, enc_privkey) VALUES ($1,$2,$3) ON CONFLICT (owner_id) DO NOTHING", [ownerId, w.address, encPk(w.privateKey)]);
  const r2 = await db.query("SELECT address, enc_privkey FROM agent_wallets WHERE owner_id=$1", [ownerId]);
  return { address: r2.rows[0].address as string, privateKey: decPk(r2.rows[0].enc_privkey as string) };
}

// --- Named agent delegate accounts (orchestrator + specialists) for A2A redelegation ----------
// Each (owner, role) is a backend-held signer keypair whose ADDRESS is the EIP-7710 `delegate`.
// Stored in agent_accounts (separate from agent_wallets, which stays the proven GMX/stock signer).
// Security is the scoped delegation + caveats, not key secrecy — see migration 0033.
// A2A multi-tier was dropped — a single backend agent account is the session/redelegator that
// receives the user's delegation and redelegates to the 1Shot relayer.
export type AgentRole = "agent";
export const AGENT_ROLES: AgentRole[] = ["agent"];

/** Get (or lazily create) the agent delegate account for an owner+role. Returns its address; the
 *  private key never leaves the backend. Reuses the same AES-256-GCM scheme as agent_wallets. */
export async function getOrCreateAgentAccount(ownerId: number, role: AgentRole): Promise<{ address: string }> {
  const row = await db.query("SELECT address FROM agent_accounts WHERE owner_id=$1 AND role=$2", [ownerId, role]);
  if (row.rowCount) return { address: row.rows[0].address as string };
  const w = Wallet.createRandom();
  await db.query(
    "INSERT INTO agent_accounts (owner_id, role, address, enc_privkey) VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id, role) DO NOTHING",
    [ownerId, role, w.address, encPk(w.privateKey)],
  );
  const r2 = await db.query("SELECT address FROM agent_accounts WHERE owner_id=$1 AND role=$2", [ownerId, role]);
  return { address: r2.rows[0].address as string };
}

/** The owner's full set of agent delegate addresses, creating any that don't yet exist. */
export async function listAgentAccounts(ownerId: number): Promise<Record<AgentRole, string>> {
  const out = {} as Record<AgentRole, string>;
  for (const role of AGENT_ROLES) out[role] = (await getOrCreateAgentAccount(ownerId, role)).address;
  return out;
}

/** Address + decrypted key for an agent account — backend signing only (orchestrator redelegation,
 *  specialist redemption in W5). Never exposed over the API. */
export async function agentAccountKey(ownerId: number, role: AgentRole): Promise<{ address: string; privateKey: string }> {
  await getOrCreateAgentAccount(ownerId, role);
  const row = await db.query("SELECT address, enc_privkey FROM agent_accounts WHERE owner_id=$1 AND role=$2", [ownerId, role]);
  return { address: row.rows[0].address as string, privateKey: decPk(row.rows[0].enc_privkey as string) };
}

function stockTokenMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env.DUALITY_STOCK_TOKENS ?? "").split(",")) {
    const [sym, addr] = pair.split(":");
    if (sym && addr) out[sym.trim().toUpperCase()] = addr.trim();
  }
  return out;
}

const VAULT_ABI = [
  "function mint(string symbol, uint256 collateralIn) returns (uint256)",
  "function redeem(string symbol, uint256 stockIn) returns (uint256)",
  "function quoteMint(string symbol, uint256 collateralIn) view returns (uint256)",
  "function priceOf(string symbol) view returns (uint256,uint64,bool)",
  "function tokenOf(string symbol) view returns (address)",
  "function marketOpen() view returns (bool)",
  "function rthOnly() view returns (bool)",
  "function maxPriceStaleness() view returns (uint256)",
];
const USDG_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

export function executionEnabled(): boolean {
  return boolEnv("DUALITY_ENABLE_TESTNET_ACTIONS", false);
}

export interface StockBuyResult {
  ok: boolean;
  error?: string;
  symbol?: string;
  chainId?: number;
  agent?: string;
  usdgSpent?: string;
  stockToken?: string;
  stockReceived?: string;
  priceUsd?: string;
  txs?: { faucet?: string; approve?: string; buy?: string };
  explorer?: string;
  truth?: Record<string, unknown>;
}

export interface StockSellResult {
  ok: boolean;
  error?: string;
  symbol?: string;
  chainId?: number;
  agent?: string;
  stockToken?: string;
  stockSold?: string;
  usdgReceived?: string;
  priceUsd?: string;
  txs?: { sell?: string };
  explorer?: string;
  truth?: Record<string, unknown>;
}

export interface StockMarketRow {
  symbol: string;
  stockToken: string;
  priceUsd: string;
  updatedAt: number;
  ageSeconds: number | null;
  fresh: boolean;
  balance: string;
  valueUsd: string;
  totalSupply: string;
  quoteBuyUsd100: string;
  truth: Record<string, unknown>;
}

export interface StockMarketState {
  ok: boolean;
  error?: string;
  configured: boolean;
  executionEnabled: boolean;
  chainId: number;
  agent?: string;
  vault?: string;
  collateral?: string;
  usdBalance?: string;
  gasBalance?: string;
  marketOpen?: boolean;
  rthOnly?: boolean;
  maxPriceStalenessSeconds?: string;
  stocks: StockMarketRow[];
  truth: Record<string, unknown>;
}

function priceToUsd(price: bigint): string {
  return (Number(price) / 1e8).toFixed(2);
}

/** Lightweight single-symbol oracle read for the order engine (price in 1e8 + freshness). */
export async function stockOraclePrice(symbol: string): Promise<{ price1e8: bigint; fresh: boolean } | null> {
  const vaultAddr = process.env.DUALITY_STOCK_VAULT_ADDRESS;
  if (!vaultAddr) return null;
  const sym = symbol.trim().toUpperCase().replace(/^D(?=[A-Z]{2,6}$)/, "");
  try {
    const vault = new Contract(vaultAddr, VAULT_ABI, rhProvider());
    const [p, , fresh] = (await vault.priceOf(sym)) as [bigint, bigint, boolean];
    return { price1e8: p, fresh };
  } catch {
    return null;
  }
}

function weiValueAtPrice(amountWei: bigint, priceUsd1e8: bigint): bigint {
  return (amountWei * priceUsd1e8) / 100000000n;
}

/** Buy a tokenized stock on Robinhood testnet: faucet-mint USDG → approve vault → vault.mint(symbol).
 *  Real on-chain txns. Returns tx hashes + the dSYMBOL balance received. */
export async function executeStockBuy(ownerId: number, symbol: string, usdgAmount: number): Promise<StockBuyResult> {
  if (!executionEnabled()) return { ok: false, error: "TESTNET_ACTIONS_DISABLED (set DUALITY_ENABLE_TESTNET_ACTIONS=true)" };
  const sym = symbol.trim().toUpperCase();
  if (!(usdgAmount > 0) || usdgAmount > MAX_BUY_USDG) return { ok: false, error: `amount must be 0 < x <= ${MAX_BUY_USDG} USDG` };
  const vaultAddr = process.env.DUALITY_STOCK_VAULT_ADDRESS;
  const usdgAddr = process.env.DUALITY_MOCK_USDG_ADDRESS;
  if (!vaultAddr || !usdgAddr) return { ok: false, error: "VAULT_NOT_CONFIGURED" };

  const provider = rhProvider();
  const wallet = await getOrCreateWallet(ownerId, provider);
  const vault = new Contract(vaultAddr, VAULT_ABI, wallet);
  const usdg = new Contract(usdgAddr, USDG_ABI, wallet);
  const amount = parseEther(String(usdgAmount));

  try {
    const [price, , fresh] = (await vault.priceOf(sym)) as [bigint, bigint, boolean];
    if (!fresh) return { ok: false, error: `STALE_PRICE for ${sym} — run the oracle keeper (push_stock_prices.py)` };
    const stockTokenAddr = stockTokenMap()[sym] || (await vault.tokenOf(sym));
    const stock = new Contract(stockTokenAddr, ERC20_ABI, provider);
    const beforeStock = (await stock.balanceOf(wallet.address).catch(() => 0n)) as bigint;

    // 1) faucet-mint test USDG to the agent (open faucet on MockUSDG), 2) approve, 3) buy.
    const faucetTx = await usdg.mint(wallet.address, amount);
    await faucetTx.wait();
    const approveTx = await usdg.approve(vaultAddr, amount);
    await approveTx.wait();
    const buyTx = await vault.mint(sym, amount);
    const rcpt = await buyTx.wait();

    const stockBal = (await stock.balanceOf(wallet.address)) as bigint;
    const received = stockBal > beforeStock ? stockBal - beforeStock : stockBal;

    return {
      ok: true, symbol: sym, chainId: RH_CHAIN_ID, agent: wallet.address,
      usdgSpent: String(usdgAmount), stockToken: stockTokenAddr,
      stockReceived: formatEther(received), priceUsd: priceToUsd(price),
      txs: { faucet: faucetTx.hash, approve: approveTx.hash, buy: buyTx.hash },
      explorer: `https://explorer.testnet.chain.robinhood.com/tx/${rcpt?.hash ?? buyTx.hash}`,
      truth: { result_tier: "TESTNET EXECUTED", venue: "robinhood_testnet", data_source: "oracle", can_execute_real_money: false,
        note: "Real testnet transaction on Robinhood Chain (46630). Tokenized stock = test token, no production rights." },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Sell/redeem a tokenized stock on Robinhood testnet: vault.redeem(symbol, stockIn) burns dSYMBOL
 *  and releases MockUSDG from the vault if the oracle is fresh and the vault has liquidity. */
export async function executeStockSell(ownerId: number, symbol: string, stockAmount: number): Promise<StockSellResult> {
  if (!executionEnabled()) return { ok: false, error: "TESTNET_ACTIONS_DISABLED (set DUALITY_ENABLE_TESTNET_ACTIONS=true)" };
  const sym = symbol.trim().toUpperCase().replace(/^D(?=[A-Z]{2,6}$)/, "");
  if (!(stockAmount > 0)) return { ok: false, error: "stockAmount must be > 0" };
  const vaultAddr = process.env.DUALITY_STOCK_VAULT_ADDRESS;
  const usdgAddr = process.env.DUALITY_MOCK_USDG_ADDRESS;
  if (!vaultAddr || !usdgAddr) return { ok: false, error: "VAULT_NOT_CONFIGURED" };

  const provider = rhProvider();
  const wallet = await getOrCreateWallet(ownerId, provider);
  const vault = new Contract(vaultAddr, VAULT_ABI, wallet);
  const usdg = new Contract(usdgAddr, USDG_ABI, provider);
  const amount = parseEther(String(stockAmount));

  try {
    const [price, , fresh] = (await vault.priceOf(sym)) as [bigint, bigint, boolean];
    if (!fresh) return { ok: false, error: `STALE_PRICE for ${sym} — run the oracle keeper (push_stock_prices.py)` };
    const stockTokenAddr = stockTokenMap()[sym] || (await vault.tokenOf(sym));
    const stock = new Contract(stockTokenAddr, ERC20_ABI, provider);
    const stockBal = (await stock.balanceOf(wallet.address)) as bigint;
    if (stockBal < amount) return { ok: false, error: `INSUFFICIENT_STOCK_BALANCE (${formatEther(stockBal)} ${sym} available)` };
    const usdgBefore = (await usdg.balanceOf(wallet.address).catch(() => 0n)) as bigint;
    const sellTx = await vault.redeem(sym, amount);
    const rcpt = await sellTx.wait();
    const usdgAfter = (await usdg.balanceOf(wallet.address).catch(() => usdgBefore)) as bigint;
    const received = usdgAfter > usdgBefore ? usdgAfter - usdgBefore : weiValueAtPrice(amount, price);

    return {
      ok: true,
      symbol: sym,
      chainId: RH_CHAIN_ID,
      agent: wallet.address,
      stockToken: stockTokenAddr,
      stockSold: formatEther(amount),
      usdgReceived: formatEther(received),
      priceUsd: priceToUsd(price),
      txs: { sell: sellTx.hash },
      explorer: `https://explorer.testnet.chain.robinhood.com/tx/${rcpt?.hash ?? sellTx.hash}`,
      truth: {
        result_tier: "TESTNET EXECUTED",
        venue: "robinhood_testnet",
        data_source: "vault_oracle",
        can_execute_real_money: false,
        note: "Real testnet redeem on Robinhood Chain (46630). Tokenized stock = test token, no production equity rights.",
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Full RH-chain stock state for the Markets page and Copilot: configured contracts, agent wallet,
 *  USDG balance, per-stock oracle freshness, balances, supplies and buy quotes. */
export async function stockMarketState(ownerId: number): Promise<StockMarketState> {
  const vaultAddr = process.env.DUALITY_STOCK_VAULT_ADDRESS;
  const usdgAddr = process.env.DUALITY_MOCK_USDG_ADDRESS;
  const envTokens = stockTokenMap();
  if (!vaultAddr || !usdgAddr || !Object.keys(envTokens).length) {
    return {
      ok: false,
      configured: false,
      executionEnabled: executionEnabled(),
      chainId: RH_CHAIN_ID,
      stocks: [],
      error: "VAULT_NOT_CONFIGURED",
      truth: {
        result_tier: "CONFIG_MISSING",
        note: "Set DUALITY_STOCK_VAULT_ADDRESS, DUALITY_MOCK_USDG_ADDRESS and DUALITY_STOCK_TOKENS to enable RH-chain stock markets.",
      },
    };
  }

  const provider = rhProvider();
  const wallet = await getOrCreateWallet(ownerId, provider);
  const vault = new Contract(vaultAddr, VAULT_ABI, provider);
  const usdg = new Contract(usdgAddr, USDG_ABI, provider);
  const [usdBal, gasBal, marketOpen, rthOnly, maxStale] = await Promise.all([
    usdg.balanceOf(wallet.address).catch(() => 0n) as Promise<bigint>,
    provider.getBalance(wallet.address).catch(() => 0n),
    vault.marketOpen().catch(() => null) as Promise<boolean | null>,
    vault.rthOnly().catch(() => null) as Promise<boolean | null>,
    vault.maxPriceStaleness().catch(() => null) as Promise<bigint | null>,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const stocks = await Promise.all(Object.entries(envTokens).map(async ([sym, envToken]): Promise<StockMarketRow> => {
    let price = 0n;
    let updatedAt = 0n;
    let fresh = false;
    let stockToken = envToken;
    try {
      const p = (await vault.priceOf(sym)) as [bigint, bigint, boolean];
      price = p[0]; updatedAt = p[1]; fresh = p[2];
      stockToken = await vault.tokenOf(sym);
    } catch {
      // keep env address and mark stale/zero so UI can show the missing oracle state.
    }
    const stock = new Contract(stockToken, ERC20_ABI, provider);
    const [balance, totalSupply] = await Promise.all([
      stock.balanceOf(wallet.address).catch(() => 0n) as Promise<bigint>,
      stock.totalSupply().catch(() => 0n) as Promise<bigint>,
    ]);
    const valueWei = weiValueAtPrice(balance, price);
    const quoteBuyUsd100 = price > 0n ? formatEther((parseEther("100") * 100000000n) / price) : "0.0";
    const ageSeconds = updatedAt > 0n ? now - Number(updatedAt) : null;
    return {
      symbol: sym,
      stockToken,
      priceUsd: priceToUsd(price),
      updatedAt: Number(updatedAt),
      ageSeconds,
      fresh,
      balance: formatEther(balance),
      valueUsd: formatEther(valueWei),
      totalSupply: formatEther(totalSupply),
      quoteBuyUsd100,
      truth: {
        data_source: "DualityStockVault.priceOf",
        reserve_model: "MockUSDG collateral vault",
        oracle_fresh: fresh,
      },
    };
  }));

  return {
    ok: true,
    configured: true,
    executionEnabled: executionEnabled(),
    chainId: RH_CHAIN_ID,
    agent: wallet.address,
    vault: vaultAddr,
    collateral: usdgAddr,
    usdBalance: formatEther(usdBal),
    gasBalance: formatEther(gasBal),
    marketOpen: marketOpen ?? undefined,
    rthOnly: rthOnly ?? undefined,
    maxPriceStalenessSeconds: maxStale == null ? undefined : maxStale.toString(),
    stocks,
    truth: {
      result_tier: "LIVE_TESTNET_STATE",
      venue: "robinhood_testnet",
      can_execute_real_money: false,
      note: "Prices and balances are read from the deployed RH-chain testnet vault/contracts. Buy/sell calls mutate testnet only.",
    },
  };
}

// ---- Arbitrum Sepolia (421614): swap + LP execution on the Duality AMM ----
const ARB_SEPOLIA_CHAIN_ID = 421614;
const AMM_PRICE = Number(process.env.DUALITY_AMM_PRICE ?? 3000); // dUSDC per dWETH (seed ratio)

// The dWETH/dUSDC AMM is seeded at a fixed ratio; the live Chainlink ETH/USD feed is the truth source.
// We annotate every swap/LP execution with the on-chain Chainlink reference + the AMM's deviation from
// it so the honesty card shows the real oracle, not just the AMM's internal quote.
async function ammChainlinkReference(): Promise<Record<string, unknown>> {
  const ref = await chainlinkReference("ETH/USD");
  if (!ref) return { available: false, source: "chainlink", note: "Chainlink ETH/USD reference unavailable (RPC error)." };
  const deviationPct = Number((((AMM_PRICE - ref.priceUsd) / ref.priceUsd) * 100).toFixed(2));
  return {
    available: true, pair: "ETH/USD", source: "chainlink", chainId: ref.chainId, feed: ref.feed,
    chainlink_price_usd: ref.priceUsd, amm_price_usd: AMM_PRICE, deviation_pct: deviationPct, stale: ref.stale,
    note: "Chainlink Arbitrum Sepolia AggregatorV3 reference. The testnet AMM is seeded at a fixed ratio, so deviation from the live oracle is expected.",
  };
}

function arbProvider(): JsonRpcProvider {
  const url = process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  return new JsonRpcProvider(url, ARB_SEPOLIA_CHAIN_ID, { staticNetwork: true });
}
const AMM_ABI = [
  "function addLiquidity(uint256 a0, uint256 a1) returns (uint256)",
  "function swap(bool zeroForOne, uint256 amountIn, uint256 minOut) returns (uint256)",
  "function quote(bool zeroForOne, uint256 amountIn) view returns (uint256)",
  "function shares(address) view returns (uint256)",
  "function reserve0() view returns (uint256)",
  "function reserve1() view returns (uint256)",
];
const MINT_ABI = ["function mint(address to, uint256 a)", "function approve(address s, uint256 a) returns (bool)", "function balanceOf(address) view returns (uint256)"];

export interface LpResult {
  ok: boolean; error?: string; venue?: string; chainId?: number; agent?: string; pool?: string;
  provided?: { dWETH: string; dUSDC: string }; lpSharesMinted?: string; txs?: Record<string, string>;
  explorer?: string; truth?: Record<string, unknown>;
}

/** Provide liquidity on the Duality AMM (Arb Sepolia): faucet-mint test dUSDC, swap half through the
 *  AMM into dWETH, then approve both sides and addLiquidity. This mirrors the "turn capital into the
 *  two LP assets" path instead of directly minting the final portfolio shape. */
export async function executeLp(ownerId: number, usdAmount: number): Promise<LpResult> {
  if (!executionEnabled()) return { ok: false, error: "TESTNET_ACTIONS_DISABLED" };
  if (!(usdAmount > 0) || usdAmount > MAX_BUY_USDG * 2) return { ok: false, error: `amount must be 0 < x <= ${MAX_BUY_USDG * 2}` };
  const amm = process.env.DUALITY_AMM_ADDRESS, t0 = process.env.DUALITY_AMM_TOKEN0, t1 = process.env.DUALITY_AMM_TOKEN1;
  if (!amm || !t0 || !t1) return { ok: false, error: "AMM_NOT_CONFIGURED" };
  const provider = arbProvider();
  const wallet = await getOrCreateWallet(ownerId, provider);
  const pool = new Contract(amm, AMM_ABI, wallet);
  const wethC = new Contract(t0, MINT_ABI, wallet), usdcC = new Contract(t1, MINT_ABI, wallet);
  const usdcTotal = parseEther(String(usdAmount.toFixed(18)));
  const usdcToSwap = usdcTotal / 2n;
  try {
    const quoted = (await pool.quote(false, usdcToSwap)) as bigint;
    if (quoted <= 0n) return { ok: false, error: "AMM_POOL_UNSEEDED" };
    const [wethBefore, usdcBefore] = await Promise.all([
      wethC.balanceOf(wallet.address).catch(() => 0n) as Promise<bigint>,
      usdcC.balanceOf(wallet.address).catch(() => 0n) as Promise<bigint>,
    ]);
    const m1 = await usdcC.mint(wallet.address, usdcTotal); await m1.wait();
    const aSwap = await usdcC.approve(amm, usdcToSwap); await aSwap.wait();
    const minWeth = (quoted * 95n) / 100n;
    const sw = await pool.swap(false, usdcToSwap, minWeth); await sw.wait();
    const [wethAfter, usdcAfter] = await Promise.all([
      wethC.balanceOf(wallet.address) as Promise<bigint>,
      usdcC.balanceOf(wallet.address) as Promise<bigint>,
    ]);
    const wethAmt = wethAfter > wethBefore ? wethAfter - wethBefore : wethAfter;
    const usdcAmt = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : usdcAfter;
    const a0 = await wethC.approve(amm, wethAmt); await a0.wait();
    const a1 = await usdcC.approve(amm, usdcAmt); await a1.wait();
    const add = await pool.addLiquidity(wethAmt, usdcAmt); const rcpt = await add.wait();
    const sh = (await pool.shares(wallet.address)) as bigint;
    const chainlink_reference = await ammChainlinkReference();
    return {
      ok: true, venue: "duality_amm_arbitrum_sepolia", chainId: ARB_SEPOLIA_CHAIN_ID, agent: wallet.address, pool: amm,
      provided: { dWETH: formatEther(wethAmt), dUSDC: formatEther(usdcAmt) }, lpSharesMinted: formatEther(sh),
      txs: { mintUsdc: m1.hash, swapUsdcToWeth: sw.hash, addLiquidity: add.hash },
      explorer: `https://sepolia.arbiscan.io/tx/${rcpt?.hash ?? add.hash}`,
      truth: { result_tier: "TESTNET EXECUTED", venue: "duality_amm", can_execute_real_money: false, chainlink_reference, note: "Real LP add on Arbitrum Sepolia: dUSDC was swapped through the AMM into dWETH, then both tokens were supplied." },
    };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function executeSwap(ownerId: number, amountInUsd: number, zeroForOne = false): Promise<Record<string, unknown>> {
  if (!executionEnabled()) return { ok: false, error: "TESTNET_ACTIONS_DISABLED" };
  const amm = process.env.DUALITY_AMM_ADDRESS, t0 = process.env.DUALITY_AMM_TOKEN0, t1 = process.env.DUALITY_AMM_TOKEN1;
  if (!amm || !t0 || !t1) return { ok: false, error: "AMM_NOT_CONFIGURED" };
  const provider = arbProvider();
  const wallet = await getOrCreateWallet(ownerId, provider);
  const pool = new Contract(amm, AMM_ABI, wallet);
  const tokenIn = new Contract(zeroForOne ? t0 : t1, MINT_ABI, wallet);
  // amountIn: when selling dUSDC (zeroForOne=false) it's the USD; when selling dWETH, convert.
  const amountIn = parseEther(String((zeroForOne ? amountInUsd / AMM_PRICE : amountInUsd).toFixed(18)));
  try {
    const mt = await tokenIn.mint(wallet.address, amountIn); await mt.wait();
    const ap = await tokenIn.approve(amm, amountIn); await ap.wait();
    const out = (await pool.quote(zeroForOne, amountIn)) as bigint;
    const minOut = (out * 95n) / 100n;
    const sw = await pool.swap(zeroForOne, amountIn, minOut); const rcpt = await sw.wait();
    const chainlink_reference = await ammChainlinkReference();
    return { ok: true, chainId: ARB_SEPOLIA_CHAIN_ID, zeroForOne, amountIn: formatEther(amountIn), expectedOut: formatEther(out),
      tx: sw.hash, explorer: `https://sepolia.arbiscan.io/tx/${rcpt?.hash ?? sw.hash}`,
      truth: { result_tier: "TESTNET EXECUTED", venue: "duality_amm", can_execute_real_money: false, chainlink_reference } };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ---- Bridge (demo lock/mint relayer) between Arbitrum Sepolia <-> Robinhood testnet ----
// No canonical deposit (that needs Eth Sepolia funds + slow withdrawals). Instead a real on-chain
// lock/mint: burn the stable on the source chain (transfer to 0x…dEaD) and mint it on the destination.
// Two tiny txns, no new contracts. Labeled a demo bridge. Keep amounts LOW (testnet gas hygiene).
const SINK = "0x000000000000000000000000000000000000dEaD";
const MINT_ABI_BRIDGE = ["function mint(address to, uint256 a)", "function transfer(address to, uint256 a) returns (bool)", "function balanceOf(address) view returns (uint256)"];

export async function executeBridge(ownerId: number, amountUsd: number, direction: "arb_to_rh" | "rh_to_arb"): Promise<Record<string, unknown>> {
  if (!executionEnabled()) return { ok: false, error: "TESTNET_ACTIONS_DISABLED" };
  if (!(amountUsd > 0) || amountUsd > 200) return { ok: false, error: "bridge demo capped at 200 (testnet gas hygiene)" };
  const usdgRh = process.env.DUALITY_MOCK_USDG_ADDRESS, usdcArb = process.env.DUALITY_AMM_TOKEN1;
  if (!usdgRh || !usdcArb) return { ok: false, error: "BRIDGE_TOKENS_NOT_CONFIGURED" };
  const amt = parseEther(String(amountUsd));
  const arbToRh = direction === "arb_to_rh";
  const srcProvider = arbToRh ? arbProvider() : rhProvider();
  const dstProvider = arbToRh ? rhProvider() : arbProvider();
  const srcWallet = await getOrCreateWallet(ownerId, srcProvider);
  const dstWallet = await getOrCreateWallet(ownerId, dstProvider);
  const srcToken = new Contract(arbToRh ? usdcArb : usdgRh, MINT_ABI_BRIDGE, srcWallet);
  const dstToken = new Contract(arbToRh ? usdgRh : usdcArb, MINT_ABI_BRIDGE, dstWallet);
  try {
    // lock on source: ensure balance then burn to sink (real on-chain)
    const ensure = await srcToken.mint(srcWallet.address, amt); await ensure.wait();
    const lock = await srcToken.transfer(SINK, amt); const lr = await lock.wait();
    // release on destination: mint the equivalent (relayer action)
    const release = await dstToken.mint(dstWallet.address, amt); const rr = await release.wait();
    const exp = (chainId: number, h: string) => chainId === ARB_SEPOLIA_CHAIN_ID ? `https://sepolia.arbiscan.io/tx/${h}` : `https://explorer.testnet.chain.robinhood.com/tx/${h}`;
    return {
      ok: true, direction, amountUsd: String(amountUsd),
      from: arbToRh ? "arbitrum_sepolia" : "robinhood_testnet", to: arbToRh ? "robinhood_testnet" : "arbitrum_sepolia",
      lockTx: lock.hash, releaseTx: release.hash,
      lockExplorer: exp(arbToRh ? ARB_SEPOLIA_CHAIN_ID : RH_CHAIN_ID, lr?.hash ?? lock.hash),
      releaseExplorer: exp(arbToRh ? RH_CHAIN_ID : ARB_SEPOLIA_CHAIN_ID, rr?.hash ?? release.hash),
      truth: { result_tier: "TESTNET EXECUTED", model: "demo_lock_mint_bridge", can_execute_real_money: false,
        note: "Demo lock/mint bridge (real txns both chains). Canonical Arbitrum bridge wiring + addresses are in config for production; a live canonical deposit needs Ethereum Sepolia funds." },
    };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export interface AgentWalletInfo {
  address: string;
  chainId: number;
  ethBalanceRh: string;
  ethBalanceArb: string;
  // ERC-20 token balances the testnet capital actually sits in (best-effort; "0" if unconfigured).
  tokens: {
    robinhood: { mockUsdG: string };
    arbitrumSepolia: { dUSDC: string; dWETH: string };
  };
}

async function erc20Balance(addr: string | undefined, holder: string, provider: JsonRpcProvider): Promise<string> {
  if (!addr) return "0";
  try {
    const bal = (await new Contract(addr, ERC20_ABI, provider).balanceOf(holder)) as bigint;
    return formatEther(bal);
  } catch { return "0"; }
}

export async function agentWalletInfo(ownerId: number): Promise<AgentWalletInfo> {
  const rh = rhProvider(); const arb = arbProvider();
  const wallet = await getOrCreateWallet(ownerId, rh);
  const [rhBal, arbBal, mockUsdG, dUSDC, dWETH] = await Promise.all([
    rh.getBalance(wallet.address),
    arb.getBalance(wallet.address).catch(() => 0n),
    erc20Balance(process.env.DUALITY_MOCK_USDG_ADDRESS, wallet.address, rh),
    erc20Balance(process.env.DUALITY_AMM_TOKEN1, wallet.address, arb), // token1 = dUSDC
    erc20Balance(process.env.DUALITY_AMM_TOKEN0, wallet.address, arb), // token0 = dWETH
  ]);
  return {
    address: wallet.address, chainId: RH_CHAIN_ID,
    ethBalanceRh: formatEther(rhBal), ethBalanceArb: formatEther(arbBal),
    tokens: { robinhood: { mockUsdG }, arbitrumSepolia: { dUSDC, dWETH } },
  };
}

export interface LaunchLegInput {
  symbol?: string;
  allocation?: number;
  weight?: number;
  target_weight?: number;
  sleeve?: string;
  asset_class?: string;
  category?: string;
  venue?: string;
  bot?: string;
  bot_type?: string;
}

export interface LaunchPlanInput {
  requestedUsd?: number;
  depositUsd?: number;
  text?: string;
  legs?: LaunchLegInput[];
}

type LaunchSleeve = "stock" | "crypto" | "lp";
type LaunchActionKind = "bridge" | "buy_stock" | "swap_hold" | "provide_lp";

export interface NormalizedLaunchLeg {
  symbol: string;
  sleeve: LaunchSleeve;
  allocation: number;
  usd: number;
  chainId: number;
  chain: "robinhood_testnet" | "arbitrum_sepolia";
  route: string;
}

export interface LaunchAction {
  id: string;
  kind: LaunchActionKind;
  chainId?: number;
  from?: "robinhood_testnet" | "arbitrum_sepolia";
  to?: "robinhood_testnet" | "arbitrum_sepolia";
  symbol?: string;
  usd: number;
  reason: string;
  endpoint?: string;
}

export interface TestnetLaunchPreflight {
  ok: boolean;
  executionEnabled: boolean;
  requestedUsd: number;
  executionUsd: number;
  capped: boolean;
  capUsd: number;
  agent: string;
  balances: {
    robinhood: { chainId: number; eth: string; mockUsdG?: string; nonce: number; marketOpen?: boolean; rthOnly?: boolean };
    arbitrumSepolia: { chainId: number; eth: string; dWETH?: string; dUSDC?: string; lpShares?: string; nonce: number; pool?: Record<string, string> };
  };
  required: { robinhoodUsd: number; arbitrumUsd: number; gas: { robinhoodEth: string; arbitrumSepoliaEth: string } };
  legs: NormalizedLaunchLeg[];
  chainlink: { prices: unknown[]; errors: Record<string, string> };
  activities: Array<{ chain: string; summary: string; detail?: string }>;
  warnings: string[];
  truth: Record<string, unknown>;
}

export interface TestnetLaunchPlan extends TestnetLaunchPreflight {
  actions: LaunchAction[];
  summary: string;
}

function launchAmount(input: LaunchPlanInput): number {
  const candidates = [input.requestedUsd, input.depositUsd];
  const m = String(input.text ?? "").match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) candidates.push(Number(m[1]));
  const raw = candidates.find((n) => Number.isFinite(n) && Number(n) > 0);
  return Number(raw ?? LAUNCH_CAP_USD);
}

function classifyLaunchLeg(leg: LaunchLegInput): LaunchSleeve {
  const text = `${leg.sleeve ?? ""} ${leg.asset_class ?? ""} ${leg.category ?? ""} ${leg.venue ?? ""} ${leg.bot ?? ""} ${leg.bot_type ?? ""}`.toLowerCase();
  const sym = String(leg.symbol ?? "").toUpperCase().replace(/^D(?=[A-Z]{2,6}$)/, "");
  if (text.includes("lp") || text.includes("uniswap") || text.includes("amm")) return "lp";
  if (text.includes("equity") || text.includes("stock") || ["TSLA", "AMZN", "PLTR", "NVDA", "AMD", "HOOD"].includes(sym)) return "stock";
  return "crypto";
}

function normalizeLaunchLegs(input: LaunchPlanInput, executionUsd: number): NormalizedLaunchLeg[] {
  const raw = input.legs?.length ? input.legs : [
    { symbol: "TSLA", sleeve: "stock", allocation: 0.35 },
    { symbol: "ETH", sleeve: "crypto", allocation: 0.30 },
    { symbol: "ETH/USDC", sleeve: "lp", allocation: 0.35 },
  ];
  const weights = raw.map((leg) => Math.max(0, Number(leg.allocation ?? leg.weight ?? leg.target_weight ?? 0)));
  const sum = weights.reduce((s, w) => s + w, 0) || raw.length;
  return raw.map((leg, i) => {
    const sleeve = classifyLaunchLeg(leg);
    const allocation = sum === raw.length && weights.every((w) => w === 0) ? 1 / raw.length : weights[i] / sum;
    const symbol = String(leg.symbol ?? (sleeve === "stock" ? "TSLA" : sleeve === "lp" ? "ETH/USDC" : "ETH")).toUpperCase().replace(/USDT$/i, "");
    return {
      symbol,
      sleeve,
      allocation,
      usd: Number((executionUsd * allocation).toFixed(2)),
      chainId: sleeve === "stock" ? RH_CHAIN_ID : ARB_SEPOLIA_CHAIN_ID,
      chain: sleeve === "stock" ? "robinhood_testnet" : "arbitrum_sepolia",
      route: sleeve === "stock"
        ? "Robinhood testnet app vault: MockUSDG -> dStock"
        : sleeve === "lp"
        ? "Arbitrum Sepolia AMM: test dUSDC -> swap half to dWETH -> add dWETH/dUSDC liquidity"
        : "Arbitrum Sepolia AMM: test dUSDC -> dWETH hold",
    };
  });
}

async function arbTestnetState(ownerId: number): Promise<TestnetLaunchPreflight["balances"]["arbitrumSepolia"]> {
  const provider = arbProvider();
  const wallet = await getOrCreateWallet(ownerId, provider);
  const amm = process.env.DUALITY_AMM_ADDRESS, t0 = process.env.DUALITY_AMM_TOKEN0, t1 = process.env.DUALITY_AMM_TOKEN1;
  const eth = await provider.getBalance(wallet.address).catch(() => 0n);
  const nonce = await provider.getTransactionCount(wallet.address).catch(() => 0);
  if (!amm || !t0 || !t1) return { chainId: ARB_SEPOLIA_CHAIN_ID, eth: formatEther(eth), nonce };
  const pool = new Contract(amm, AMM_ABI, provider);
  const weth = new Contract(t0, MINT_ABI, provider);
  const usdc = new Contract(t1, MINT_ABI, provider);
  const [dWETH, dUSDC, lpShares, reserve0, reserve1] = await Promise.all([
    weth.balanceOf(wallet.address).catch(() => 0n) as Promise<bigint>,
    usdc.balanceOf(wallet.address).catch(() => 0n) as Promise<bigint>,
    pool.shares(wallet.address).catch(() => 0n) as Promise<bigint>,
    pool.reserve0().catch(() => 0n) as Promise<bigint>,
    pool.reserve1().catch(() => 0n) as Promise<bigint>,
  ]);
  return {
    chainId: ARB_SEPOLIA_CHAIN_ID,
    eth: formatEther(eth),
    dWETH: formatEther(dWETH),
    dUSDC: formatEther(dUSDC),
    lpShares: formatEther(lpShares),
    nonce,
    pool: { address: amm, reserveDWETH: formatEther(reserve0), reserveDUSDC: formatEther(reserve1) },
  };
}

export async function testnetLaunchPreflight(ownerId: number, input: LaunchPlanInput): Promise<TestnetLaunchPreflight> {
  const requestedUsd = launchAmount(input);
  const executionUsd = Math.min(requestedUsd, LAUNCH_CAP_USD);
  const legs = normalizeLaunchLegs(input, executionUsd);
  const [wallet, stocks, arb, cryptoFeeds, stockFeeds] = await Promise.all([
    agentWalletInfo(ownerId),
    stockMarketState(ownerId),
    arbTestnetState(ownerId),
    readChainlinkMany(["ETH/USD", "USDC/USD", "ARB/USD", "LINK/USD"]).catch((e) => ({ prices: [], errors: { chainlink: (e as Error).message } })),
    readStockFeedMany().catch((e) => ({ prices: [], errors: { stocks: (e as Error).message } })),
  ]);
  // Crypto Chainlink feeds + equity AggregatorV3 stand-in feeds, surfaced through one panel.
  const chainlink = { prices: [...cryptoFeeds.prices, ...stockFeeds.prices], errors: { ...cryptoFeeds.errors, ...stockFeeds.errors } };
  const robinhoodUsd = Number(legs.filter((l) => l.sleeve === "stock").reduce((s, l) => s + l.usd, 0).toFixed(2));
  const arbitrumUsd = Number(legs.filter((l) => l.sleeve !== "stock").reduce((s, l) => s + l.usd, 0).toFixed(2));
  const warnings: string[] = [];
  if (requestedUsd > LAUNCH_CAP_USD) warnings.push(`Requested $${requestedUsd} was capped to $${LAUNCH_CAP_USD} for testnet launch.`);
  if (!executionEnabled()) warnings.push("DUALITY_ENABLE_TESTNET_ACTIONS is disabled; the plan can be previewed but not executed.");
  if (!stocks.configured) warnings.push("Robinhood stock vault is not configured.");
  if (!arb.pool) warnings.push("Arbitrum Sepolia AMM is not configured.");
  if (stocks.rthOnly) warnings.push("Vault reports RTH-only mode; app execution layer treats testnet stock launch as 24/7 only if the deployed vault allows it.");
  return {
    ok: true,
    executionEnabled: executionEnabled(),
    requestedUsd,
    executionUsd,
    capped: requestedUsd !== executionUsd,
    capUsd: LAUNCH_CAP_USD,
    agent: wallet.address,
    balances: {
      robinhood: {
        chainId: RH_CHAIN_ID,
        eth: wallet.ethBalanceRh,
        mockUsdG: stocks.usdBalance,
        nonce: await rhProvider().getTransactionCount(wallet.address).catch(() => 0),
        marketOpen: stocks.marketOpen,
        rthOnly: stocks.rthOnly,
      },
      arbitrumSepolia: arb,
    },
    required: { robinhoodUsd, arbitrumUsd, gas: { robinhoodEth: GAS_TOPUP, arbitrumSepoliaEth: GAS_TOPUP } },
    legs,
    chainlink,
    activities: [
      { chain: "Robinhood Chain testnet", summary: `${stocks.stocks.length} stock markets configured`, detail: `MockUSDG ${stocks.usdBalance ?? "0"} · nonce ${await rhProvider().getTransactionCount(wallet.address).catch(() => 0)}` },
      { chain: "Arbitrum Sepolia", summary: arb.pool ? "AMM pool configured" : "AMM not configured", detail: `dWETH ${arb.dWETH ?? "0"} · dUSDC ${arb.dUSDC ?? "0"} · LP ${arb.lpShares ?? "0"} · nonce ${arb.nonce}` },
      { chain: "Chainlink Arbitrum Sepolia", summary: `${chainlink.prices.length} feeds readable`, detail: Object.keys(chainlink.errors).length ? JSON.stringify(chainlink.errors) : "ETH/USD, USDC/USD, ARB/USD, LINK/USD" },
    ],
    warnings,
    truth: {
      result_tier: "TESTNET_PREFLIGHT",
      can_execute_real_money: false,
      chains: [RH_CHAIN_ID, ARB_SEPOLIA_CHAIN_ID],
      note: "No mainnet routes are used. All launch amounts are capped to $20 server-side.",
    },
  };
}

export async function buildTestnetLaunchPlan(ownerId: number, input: LaunchPlanInput): Promise<TestnetLaunchPlan> {
  const preflight = await testnetLaunchPreflight(ownerId, input);
  // Precise cross-chain funding: each sleeve needs collateral on its OWN chain (stocks → MockUSDG on
  // Robinhood Chain; crypto + LP → dUSDC on Arbitrum Sepolia). Compute the per-chain deficit/surplus and
  // bridge the EXACT shortfall from whichever chain holds the funds — as the first execution step(s).
  const round2 = (n: number) => Number(n.toFixed(2));
  const rhNeed = preflight.required.robinhoodUsd;
  const arbNeed = preflight.required.arbitrumUsd;
  const rhHave = Number(preflight.balances.robinhood.mockUsdG ?? 0);
  const arbHave = Number(preflight.balances.arbitrumSepolia.dUSDC ?? 0);
  const rhDeficit = Math.max(0, rhNeed - rhHave), arbDeficit = Math.max(0, arbNeed - arbHave);
  const rhSurplus = Math.max(0, rhHave - rhNeed), arbSurplus = Math.max(0, arbHave - arbNeed);
  const actions: LaunchAction[] = [];
  if (arbDeficit > 0 && rhSurplus > 0) {
    const amt = round2(Math.min(arbDeficit, rhSurplus));
    actions.push({ id: "bridge-rh-arb", kind: "bridge", from: "robinhood_testnet", to: "arbitrum_sepolia", usd: amt,
      reason: `Arbitrum sleeve needs $${arbNeed.toFixed(2)} dUSDC but the agent holds $${arbHave.toFixed(2)}; bridging $${amt.toFixed(2)} from the Robinhood-chain balance ($${rhHave.toFixed(2)}).`,
      endpoint: "/api/exec/bridge" });
  }
  if (rhDeficit > 0 && arbSurplus > 0) {
    const amt = round2(Math.min(rhDeficit, arbSurplus));
    actions.push({ id: "bridge-arb-rh", kind: "bridge", from: "arbitrum_sepolia", to: "robinhood_testnet", usd: amt,
      reason: `Stock sleeve needs $${rhNeed.toFixed(2)} MockUSDG but the agent holds $${rhHave.toFixed(2)}; bridging $${amt.toFixed(2)} from the Arbitrum-Sepolia balance ($${arbHave.toFixed(2)}).`,
      endpoint: "/api/exec/bridge" });
  }
  for (const leg of preflight.legs) {
    if (leg.usd <= 0) continue;
    if (leg.sleeve === "stock") actions.push({ id: `stock-${leg.symbol}`, kind: "buy_stock", chainId: RH_CHAIN_ID, symbol: leg.symbol.replace(/^D/, ""), usd: leg.usd, reason: "Buy tokenized stock from the app vault on Robinhood Chain testnet.", endpoint: "/api/exec/stock-buy" });
    else if (leg.sleeve === "lp") actions.push({ id: `lp-${leg.symbol}`, kind: "provide_lp", chainId: ARB_SEPOLIA_CHAIN_ID, symbol: leg.symbol, usd: leg.usd, reason: "Swap half of test dUSDC into dWETH through the AMM, then provide dWETH/dUSDC liquidity.", endpoint: "/api/exec/lp" });
    else actions.push({ id: `swap-${leg.symbol}`, kind: "swap_hold", chainId: ARB_SEPOLIA_CHAIN_ID, symbol: leg.symbol, usd: leg.usd, reason: "Swap test dUSDC into dWETH on Arbitrum Sepolia for the crypto sleeve.", endpoint: "/api/exec/swap" });
  }
  return {
    ...preflight,
    actions,
    summary: `Launch preview uses $${preflight.executionUsd.toFixed(2)} testnet capital across ${preflight.legs.length} legs. ${preflight.capped ? `Original request $${preflight.requestedUsd} was capped.` : "No cap adjustment needed."}`,
  };
}

export async function executeTestnetLaunchPlan(ownerId: number, input: LaunchPlanInput): Promise<Record<string, unknown>> {
  const plan = await buildTestnetLaunchPlan(ownerId, input);
  if (!executionEnabled()) return { ok: false, error: "TESTNET_ACTIONS_DISABLED", plan };
  const results: Array<Record<string, unknown>> = [];
  // Isolate each action: an uncaught throw in one (wallet setup, RPC, revert) must NOT abort the whole
  // launch and surface as a single opaque 500 — every step gets its own ok/error.
  for (const action of plan.actions) {
    try {
      let r: Record<string, unknown>;
      if (action.kind === "bridge") r = await executeBridge(ownerId, action.usd, action.from === "arbitrum_sepolia" ? "arb_to_rh" : "rh_to_arb");
      else if (action.kind === "buy_stock") r = await executeStockBuy(ownerId, action.symbol ?? "TSLA", action.usd) as unknown as Record<string, unknown>;
      else if (action.kind === "provide_lp") r = await executeLp(ownerId, action.usd) as unknown as Record<string, unknown>;
      else if (action.kind === "swap_hold") r = await executeSwap(ownerId, action.usd, false);
      else r = { ok: false, error: `unknown action kind: ${action.kind}` };
      results.push({ action, ...r });
    } catch (e) {
      results.push({ action, ok: false, error: (e as Error).message });
    }
  }
  const executed = results.filter((r) => r.ok).length;
  return {
    ok: executed > 0,
    status: executed > 0 ? "TESTNET_EXECUTED" : "NO_ACTION_EXECUTED",
    plan,
    executed,
    total: plan.actions.length,
    results,
    truth: { result_tier: executed > 0 ? "TESTNET EXECUTED" : "NOT_EXECUTED", can_execute_real_money: false, note: "Executed only Robinhood Chain testnet and Arbitrum Sepolia actions, with $20 server-side cap." },
  };
}
