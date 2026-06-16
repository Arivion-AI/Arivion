// Multi-chain execution config for the 1Shot delegated path. The cross-chain demo uses Arbitrum One
// (source: user's USDC) <-> Base (low-cost L2 destination). Both are 1Shot-supported and CCTP-native.
// All addresses are canonical mainnet contracts.
import { arbitrum, base, type Chain } from "viem/chains";
import { getAddress, type Address } from "viem";

export interface ExecChain {
  chainId: number;
  chain: Chain;
  rpc: string;
  usdc: Address;
  cctpDomain: number;                 // Circle CCTP domain
  uniswapNpm: Address;                // Uniswap v3 NonfungiblePositionManager
  uniswapSwapRouter: Address;         // Uniswap SwapRouter02
  ethUsdcPool: Address;               // Uniswap v3 WETH/native-USDC 0.05% pool (the plan's LP venue)
}

export const EXEC_CHAINS: Record<number, ExecChain> = {
  42161: {
    chainId: 42161, chain: arbitrum,
    rpc: process.env.ARBITRUM_ONE_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    usdc: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    cctpDomain: 3,
    uniswapNpm: getAddress("0xC36442b4a4522E871399CD717aBDD847Ab11FE88"),
    uniswapSwapRouter: getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"),
    // WETH/native-USDC 0.05% — verified on-chain via the Uniswap v3 factory (active liquidity).
    ethUsdcPool: getAddress(process.env.DUALITY_ARB_ETHUSDC_POOL ?? "0xC6962004f452bE9203591991D15f6b388e09E8D0"),
  },
  8453: {
    chainId: 8453, chain: base,
    rpc: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    cctpDomain: 6,
    uniswapNpm: getAddress("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"),
    uniswapSwapRouter: getAddress("0x2626664c2603336E57B271c5C0b26F421741e481"),
    // WETH/native-USDC 0.05% — verified on-chain via the Base Uniswap v3 factory (active liquidity).
    ethUsdcPool: getAddress(process.env.DUALITY_BASE_ETHUSDC_POOL ?? "0xd0b53D9277642d899DF5C87A3966A349A798F224"),
  },
};

export const DEFAULT_EXEC_CHAIN = Number(process.env.DUALITY_EXEC_CHAIN_ID ?? 42161);
// Cross-chain destination default (low-cost L2).
export const CROSSCHAIN_DEST_CHAIN = Number(process.env.DUALITY_CROSSCHAIN_DEST ?? 8453);

export function execChain(chainId: number): ExecChain {
  const c = EXEC_CHAINS[chainId];
  if (!c) throw new Error(`UNSUPPORTED_EXEC_CHAIN: ${chainId}`);
  return c;
}
