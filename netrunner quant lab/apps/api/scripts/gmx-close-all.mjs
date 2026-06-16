// Close ALL open GMX positions on the test wallet and return collateral (USDC) to the wallet.
// Uses the same proven path as the backend close route: GMX express decrease order (receiveToken USDC,
// keepLeverage false → withdraw freed collateral). Run from apps/api: node scripts/gmx-close-all.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { GmxApiSdk, PrivateKeySigner } = require("@gmx-io/sdk/v2");
import { createPublicClient, http, getAddress, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

let pk = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim();
if (!pk) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
if (!pk.startsWith("0x")) pk = `0x${pk}`;
const user = getAddress(privateKeyToAccount(pk).address);
const RPC = (process.env.ARBITRUM_ONE_RPC_URL || "https://arb1.arbitrum.io/rpc").trim();
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");

const pc = createPublicClient({ chain: arbitrum, transport: http(RPC) });
const usdcBal = async () => Number(formatUnits(await pc.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [user] }), 6));

console.log("=== Close all GMX positions →", user, "===");
console.log("USDC before:", await usdcBal());

const sdk = new GmxApiSdk({ chainId: 42161 });
const signer = new PrivateKeySigner(pk);
// Map marketTokenAddress → fully-qualified market symbol (e.g. "ETH/USD [WETH-USDC]"), which the
// express decrease API requires (the bare indexName "ETH/USD" is rejected).
const markets = (await sdk.fetchMarkets()) ?? [];
const addrToSymbol = new Map(markets.map((m) => [String(m.marketTokenAddress ?? m.marketToken ?? m.address ?? "").toLowerCase(), String(m.symbol ?? "")]));
const resolveSymbol = (p) => {
  const mAddr = String(p.marketAddress ?? p.market ?? p.marketTokenAddress ?? "").toLowerCase();
  if (addrToSymbol.get(mAddr)) return addrToSymbol.get(mAddr);
  const base = String(p.indexName ?? "").split("/")[0];
  return markets.find((m) => String(m.symbol ?? "").toUpperCase().startsWith(`${base}/USD`) && /\[[^\]]*USDC[^\]]*\]/i.test(String(m.symbol ?? "")))?.symbol ?? p.indexName;
};
const positions = (await sdk.fetchPositionsInfo({ address: user, includeRelatedOrders: false })) ?? [];
const open = positions.filter((p) => BigInt(p.sizeInUsd ?? 0n) > 0n);
console.log(`open positions: ${open.length}`);
for (const p of open) console.log(`  ${p.indexName} → "${resolveSymbol(p)}" | ${p.isLong ? "LONG" : "SHORT"} | size $${(Number(p.sizeInUsd) / 1e30).toFixed(2)}`);

for (const p of open) {
  const direction = p.isLong ? "long" : "short";
  const symbol = resolveSymbol(p); // fully-qualified market symbol
  const request = {
    kind: "decrease", symbol, direction, orderType: "market",
    size: BigInt(p.sizeInUsd), collateralToken: "USDC", receiveToken: "USDC",
    keepLeverage: false, slippage: 100, mode: "express", from: user,
  };
  try {
    const submitted = await sdk.executeExpressOrder(request, signer);
    console.log(`✓ close submitted: ${symbol} ${direction} | requestId ${submitted?.requestId ?? "?"} | status ${submitted?.status ?? "?"}`);
  } catch (e) {
    console.error(`✗ close failed for ${symbol} ${direction}:`, e.message?.slice(0, 200));
  }
}

console.log("\nDecrease orders submitted to GMX express relay. Keepers execute in seconds; freed collateral");
console.log("returns to the wallet as USDC. Re-check balance in ~30-60s.");
console.log("USDC now (pre-keeper):", await usdcBal());
