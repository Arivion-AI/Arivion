// Uniswap v3 swap encoded as plain {to,data,value} executions for redemption through the 1Shot
// delegated relayer (gas in USDC). Lets the agent convert part of a user's USDC into an LP-pair token
// (e.g. USDC -> WETH) before providing liquidity — all without the user holding ETH or signing again.
// Output is [USDC.approve(SwapRouter02, amountIn), SwapRouter02.exactInputSingle(params)];
// smartAccountExec prepends the 1Shot USDC fee and submits.

import { encodeFunctionData, parseAbi, getAddress, type Address, type Hex } from "viem";
import type { Execution7710 } from "./oneShotRelayer.js";

const SWAP_ROUTER_02: Address = getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"); // Arbitrum One
const USDC: Address = getAddress(process.env.ONESHOT_FEE_TOKEN ?? "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
// SwapRouter02.exactInputSingle has NO deadline (unlike v1 SwapRouter).
const SWAP_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[])",
]);
// SwapRouter02 sentinel: recipient = the router itself (so it holds the WETH before unwrapWETH9).
const ADDRESS_THIS: Address = getAddress("0x0000000000000000000000000000000000000002");
const WETH_ARB: Address = getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");

export interface SwapPlan {
  router: Address;
  tokenIn: Address; tokenOut: Address; feeTier: number;
  amountIn: string; amountOutMin: string; recipient: Address;
  note: string;
}
export interface SwapBuild { plan: SwapPlan; executions: Execution7710[] }

/** Build a USDC -> tokenOut exact-input swap into executions. `usdcAmount` is whole USDC; `recipient`
 *  is the user (delegator) who receives tokenOut. `amountOutMin` defaults to 0 (caller should pass a
 *  slippage-bounded min for production); `feeTier` is the Uniswap v3 pool fee (e.g. 500 = 0.05%). */
export function buildUsdcSwap(opts: {
  tokenOut: string;
  usdcAmount: number;
  recipient: string;
  feeTier?: number;
  amountOutMin?: bigint;
}): SwapBuild {
  const tokenOut = getAddress(opts.tokenOut);
  const recipient = getAddress(opts.recipient);
  const feeTier = opts.feeTier ?? 500;
  const amountIn = BigInt(Math.round(opts.usdcAmount * 1e6));
  const amountOutMin = opts.amountOutMin ?? 0n;

  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER_02, amountIn] }) as Hex;
  const swapData = encodeFunctionData({
    abi: SWAP_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: USDC, tokenOut, fee: feeTier, recipient,
      amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
    }],
  }) as Hex;

  const executions: Execution7710[] = [
    { target: USDC, value: "0x0", data: approveData },
    { target: SWAP_ROUTER_02, value: "0x0", data: swapData },
  ];
  const plan: SwapPlan = {
    router: SWAP_ROUTER_02, tokenIn: USDC, tokenOut, feeTier,
    amountIn: amountIn.toString(), amountOutMin: amountOutMin.toString(), recipient,
    note: `Swap ${opts.usdcAmount} USDC -> ${tokenOut} (fee ${feeTier / 10000}%) on Uniswap v3, recipient ${recipient}.`,
  };
  return { plan, executions };
}

/** Build a USDC -> NATIVE ETH swap: [USDC.approve, SwapRouter02.multicall([exactInputSingle(USDC→WETH,
 *  recipient=router), unwrapWETH9(min, recipient=agent)])]. The router swaps to WETH it holds, then
 *  unwraps and sends native ETH to `recipient` in one atomic call. Lets the agent self-fund GMX's native
 *  keeper fee from USDC — no ETH seeding. `usdcAmount` is whole USDC. */
export function buildUsdcToEth(opts: { usdcAmount: number; recipient: string; feeTier?: number; amountOutMin?: bigint }): SwapBuild {
  const recipient = getAddress(opts.recipient);
  const feeTier = opts.feeTier ?? 500;
  const amountIn = BigInt(Math.round(opts.usdcAmount * 1e6));
  const amountOutMin = opts.amountOutMin ?? 0n;

  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SWAP_ROUTER_02, amountIn] }) as Hex;
  const swapInner = encodeFunctionData({
    abi: SWAP_ABI, functionName: "exactInputSingle",
    args: [{ tokenIn: USDC, tokenOut: WETH_ARB, fee: feeTier, recipient: ADDRESS_THIS, amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n }],
  }) as Hex;
  const unwrapInner = encodeFunctionData({ abi: SWAP_ABI, functionName: "unwrapWETH9", args: [amountOutMin, recipient] }) as Hex;
  const multicallData = encodeFunctionData({ abi: SWAP_ABI, functionName: "multicall", args: [[swapInner, unwrapInner]] }) as Hex;

  const executions: Execution7710[] = [
    { target: USDC, value: "0x0", data: approveData },
    { target: SWAP_ROUTER_02, value: "0x0", data: multicallData },
  ];
  const plan: SwapPlan = {
    router: SWAP_ROUTER_02, tokenIn: USDC, tokenOut: WETH_ARB, feeTier,
    amountIn: amountIn.toString(), amountOutMin: amountOutMin.toString(), recipient,
    note: `Swap ${opts.usdcAmount} USDC -> native ETH (via WETH unwrap) on Uniswap v3, recipient ${recipient}.`,
  };
  return { plan, executions };
}
