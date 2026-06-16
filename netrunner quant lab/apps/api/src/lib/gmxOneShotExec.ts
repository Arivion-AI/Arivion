// GMX v2 → 1Shot adapter (server-side). Builds a REAL GMX order via @gmx-io/sdk (live prices/market/
// execution fee), captures the exact ExchangeRouter.multicall calldata + ETH value by intercepting the
// SDK's own send, then relays it through the 1Shot permissionless relayer as an EIP-7710 delegated
// execution (gas in USDC) via the canonical submitDelegatedBundle.
//
// Proven live on Arbitrum One mainnet (see GMX_TO_1SHOT.md): a 2-USDC ETH long landed via
// relayer_send7710Transaction, tx 0x772bcc8…36c8. The executing account (the owner's agent wallet) must
// hold USDC collateral + a little ETH (GMX's keeper execution fee is native, carried as value) and have
// approved the GMX Router for USDC.

import { createRequire } from "node:module";
import { getAddress, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from "viem";
import { agentAccountKey } from "./agentExec.js";
import { submitAsAgent } from "./smartAccountExec.js";
import * as relayer from "./oneShotRelayer.js";
import { execChain } from "./execChains.js";

const requireCjs = createRequire(import.meta.url);
const MULTICALL_ABI = parseAbi(["function multicall(bytes[] data) payable returns (bytes[])"]);

// GMX v2 is Arbitrum One only on the 1Shot path.
const GMX_CHAIN = 42161;
const GMX_ORACLE_URL = "https://arbitrum-api.gmxinfra.io";
const GMX_SUBSQUID_URL = "https://gmx.squids.live/gmx-synthetics-arbitrum:live/api/graphql";
// ETH/USD [WETH-USDC] GM market (deepest, USDC-collateral).
export const GMX_ETH_USD_MARKET = getAddress("0x70d95587d40A2caf56bd97485aB3Eec10Bee6336");

export interface GmxOneShotParams {
  ownerId: number;
  marketAddress?: Address;   // defaults to ETH/USD
  collateralUsd: number;     // USDC collateral (>= ~2 to clear GMX minimums)
  leverageBps?: number;      // default 20000 = 2x
  isLong?: boolean;          // default true
  allowedSlippageBps?: number;
}

/** Build the exact GMX ExchangeRouter.multicall execution by intercepting the SDK's send. Returns the
 *  {to, value, data} the SDK itself would broadcast — correct live prices, market, and execution fee. */
export async function buildGmxExecution(account: Address, p: GmxOneShotParams): Promise<{
  exchangeRouter: Address; callData: Hex; executionFeeWei: bigint;
}> {
  const { GmxSdk } = requireCjs("@gmx-io/sdk") as { GmxSdk: new (cfg: Record<string, unknown>) => {
    callContract: (...a: unknown[]) => Promise<unknown>;
    orders: { long: (x: Record<string, unknown>) => Promise<unknown>; short: (x: Record<string, unknown>) => Promise<unknown> };
  } };
  const usdc = execChain(GMX_CHAIN).usdc;
  const sdk = new GmxSdk({ chainId: GMX_CHAIN, account, rpcUrl: execChain(GMX_CHAIN).rpc, oracleUrl: GMX_ORACLE_URL, subsquidUrl: GMX_SUBSQUID_URL });

  let captured: { address: Address; params: unknown[]; value: bigint } | null = null;
  sdk.callContract = async (address: unknown, _abi: unknown, method: unknown, params: unknown, opts: unknown) => {
    if (method !== "multicall") throw new Error(`unexpected GMX call ${String(method)}`);
    captured = { address: getAddress(address as string), params: params as unknown[], value: BigInt((opts as { value?: bigint })?.value ?? 0n) };
    throw new Error("__INTERCEPTED__");
  };

  const orderParams = {
    payTokenAddress: usdc,
    collateralTokenAddress: usdc,
    marketAddress: p.marketAddress ?? GMX_ETH_USD_MARKET,
    payAmount: BigInt(Math.round(p.collateralUsd * 1e6)),
    leverage: BigInt(p.leverageBps ?? 20000),
    allowedSlippageBps: p.allowedSlippageBps ?? 100,
    skipSimulation: true,
  };
  try {
    await (p.isLong === false ? sdk.orders.short(orderParams) : sdk.orders.long(orderParams));
  } catch (e) {
    if ((e as Error).message !== "__INTERCEPTED__") throw e;
  }
  if (!captured) throw new Error("GMX_BUILD_FAILED: did not capture ExchangeRouter.multicall");
  const cap = captured as { address: Address; params: unknown[]; value: bigint };
  return {
    exchangeRouter: cap.address,
    callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "multicall", args: cap.params as [Hex[]] }),
    executionFeeWei: cap.value,
  };
}

// GMX Router (the plugin-transfer router USDC collateral is approved to; ExchangeRouter.sendTokens
// pulls via Router.pluginTransfer). Distinct from the ExchangeRouter (the multicall target).
const GMX_ROUTER = getAddress("0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6");
const ERC20_APPROVE = parseAbi(["function approve(address,uint256) returns (bool)"]);
const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

/** Execute a GMX order through 1Shot FROM THE AGENT'S OWN ACCOUNT (Stage B). Builds the real
 *  ExchangeRouter.multicall via the SDK (receiver = the agent), prepends a USDC.approve to the GMX
 *  Router, and relays [approve, multicall(value)] via submitAsAgent (agent FunctionCall delegation →
 *  1Shot, gas in USDC; in-flight 7702 upgrade on first use). The agent must hold the USDC collateral
 *  (from Stage A) + a little ETH for GMX's native keeper fee. */
export async function executeGmxViaOneShot(p: GmxOneShotParams): Promise<{ ok: true; taskId: string; feeUsdc: number; exchangeRouter: Address; executionFeeWei: string } | { ok: false; error: string }> {
  try {
    const { address } = await agentAccountKey(p.ownerId, "agent");
    const agent = getAddress(address);

    const { exchangeRouter, callData, executionFeeWei } = await buildGmxExecution(agent, p);

    // [USDC.approve(GMX Router, collateral+fee), ExchangeRouter.multicall{value: keeper fee}]
    const approveAmount = BigInt(Math.round((p.collateralUsd + 1) * 1e6));
    const workExecutions: relayer.Execution7710[] = [
      { target: execChain(GMX_CHAIN).usdc, value: "0x0", data: encodeFunctionData({ abi: ERC20_APPROVE, functionName: "approve", args: [GMX_ROUTER, approveAmount > MAX_UINT256 ? MAX_UINT256 : approveAmount] }) },
      { target: exchangeRouter, value: toHex(executionFeeWei), data: callData },
    ];
    const r = await submitAsAgent({
      ownerId: p.ownerId, chainId: GMX_CHAIN, workExecutions,
      allowedTargets: [exchangeRouter, GMX_ROUTER], selectors: ["multicall(bytes[])"],
      valueCapWei: executionFeeWei * 2n + BigInt("1000000000000000"),
      kind: "gmx_order", memo: `gmx_1shot:${p.isLong === false ? "short" : "long"}:${p.collateralUsd}usdc`,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, taskId: r.taskId, feeUsdc: r.feeUsdc, exchangeRouter, executionFeeWei: executionFeeWei.toString() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
