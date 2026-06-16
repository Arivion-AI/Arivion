// Real Uniswap v3 liquidity DEPOSIT into an EXISTING pool on Arbitrum One, encoded as plain
// {to,data,value} executions so it can be redeemed through the 1Shot delegated relayer (gas in USDC).
// We never create/initialize a pool — we add liquidity to a pool the agent already found
// (NonfungiblePositionManager.mint targets an existing pool by token0/token1/fee).
//
// To keep deposits minimal and single-token (only the user's USDC, no WETH, no swap), we mint a
// SINGLE-SIDED position: a tick range entirely on the USDC side of the current price, so only USDC is
// required. This is a normal v3 position in the existing pool.
//
// Output is the work executions [USDC.approve(NPM, amt), NPM.mint(params)]; smartAccountExec prepends
// the 1Shot USDC fee transfer and submits the delegated bundle.

import { createPublicClient, http, encodeFunctionData, parseAbi, getAddress, type Address, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import type { Execution7710 } from "./oneShotRelayer.js";
import { execChain } from "./execChains.js";

const NPM: Address = getAddress("0xC36442b4a4522E871399CD717aBDD847Ab11FE88"); // NonfungiblePositionManager (Arb One)
const ARB_RPC = process.env.ARBITRUM_ONE_RPC_URL ?? "https://arb1.arbitrum.io/rpc";

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const NPM_ABI = parseAbi([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
]);

function publicClient() {
  return createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });
}

const floorToSpacing = (tick: number, spacing: number) => Math.floor(tick / spacing) * spacing;

export interface LpDepositPlan {
  pool: Address;
  token0: Address; token1: Address; fee: number;
  currentTick: number; tickSpacing: number;
  usdcSide: "token0" | "token1";
  tickLower: number; tickUpper: number;
  usdcAtoms: string;             // amount of USDC deposited (6-decimals)
  recipient: Address;
  bandTicks: number;
  note: string;
}

export interface LpDepositBuild {
  plan: LpDepositPlan;
  executions: Execution7710[];   // [approve, mint]
}

const USDC: Address = getAddress(process.env.ONESHOT_FEE_TOKEN ?? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");

/** Build a single-sided USDC deposit into an EXISTING Uniswap v3 pool. `usdcAmount` is whole USDC.
 *  `recipient` is the user (delegator) who receives the position NFT. Reads pool state on-chain. */
export async function buildUniswapV3Deposit(opts: {
  poolAddress: string;
  usdcAmount: number;
  recipient: string;
  chainId?: number;              // chain the pool lives on (42161 Arbitrum default, 8453 Base)
  bandTicks?: number;            // how wide the single-sided band is (in tick-spacings)
  deadlineSec?: number;
}): Promise<LpDepositBuild> {
  // Read the pool + build the deposit on the POOL's chain — not a hardcoded Arbitrum client (a Base pool
  // read on the Arbitrum RPC returns 0x). USDC + NonfungiblePositionManager are the chain's, too.
  const chainCfg = execChain(opts.chainId ?? 42161);
  const pc = createPublicClient({ chain: chainCfg.chain, transport: http(chainCfg.rpc) });
  const USDC = chainCfg.usdc;
  const NPM = chainCfg.uniswapNpm;
  const pool = getAddress(opts.poolAddress);
  const [slot0, spacingRaw, t0, t1, feeRaw] = await Promise.all([
    pc.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
    pc.readContract({ address: pool, abi: POOL_ABI, functionName: "tickSpacing" }),
    pc.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
    pc.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }),
    pc.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }),
  ]);
  const currentTick = Number((slot0 as unknown as [bigint, number])[1]);
  const tickSpacing = Number(spacingRaw);
  const token0 = getAddress(t0 as string);
  const token1 = getAddress(t1 as string);
  const fee = Number(feeRaw);

  const usdcIsToken0 = token0.toLowerCase() === USDC.toLowerCase();
  const usdcIsToken1 = token1.toLowerCase() === USDC.toLowerCase();
  if (!usdcIsToken0 && !usdcIsToken1) throw new Error("POOL_HAS_NO_USDC");

  const band = Math.max(1, opts.bandTicks ?? 20);
  const usdcAtoms = BigInt(Math.round(opts.usdcAmount * 1e6));

  // Single-sided USDC: a range entirely on the USDC side of the current price needs only USDC.
  // USDC=token1 -> range BELOW current tick; USDC=token0 -> range ABOVE current tick.
  let tickLower: number, tickUpper: number, amount0Desired = 0n, amount1Desired = 0n;
  const base = floorToSpacing(currentTick, tickSpacing);
  if (usdcIsToken1) {
    tickUpper = base - tickSpacing;            // strictly below current
    tickLower = tickUpper - band * tickSpacing;
    amount1Desired = usdcAtoms;
  } else {
    tickLower = base + tickSpacing;            // strictly above current
    tickUpper = tickLower + band * tickSpacing;
    amount0Desired = usdcAtoms;
  }

  const recipient = getAddress(opts.recipient);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSec ?? 1200));

  // approve(NPM, usdcAtoms) on USDC, then NPM.mint into the existing pool.
  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [NPM, usdcAtoms] }) as Hex;
  const mintData = encodeFunctionData({
    abi: NPM_ABI,
    functionName: "mint",
    args: [{
      token0, token1, fee, tickLower, tickUpper,
      amount0Desired, amount1Desired,
      amount0Min: 0n, amount1Min: 0n,    // single-sided exact-token deposit; tolerant mins
      recipient, deadline,
    }],
  }) as Hex;

  const executions: Execution7710[] = [
    { target: USDC, value: "0x0", data: approveData },
    { target: NPM, value: "0x0", data: mintData },
  ];

  const plan: LpDepositPlan = {
    pool, token0, token1, fee, currentTick, tickSpacing,
    usdcSide: usdcIsToken1 ? "token1" : "token0",
    tickLower, tickUpper, usdcAtoms: usdcAtoms.toString(), recipient, bandTicks: band,
    note: `Single-sided USDC deposit into existing pool ${pool} (${usdcIsToken1 ? "range below" : "range above"} current tick ${currentTick}). Mints a v3 position NFT to ${recipient}; no pool is created.`,
  };
  return { plan, executions };
}
