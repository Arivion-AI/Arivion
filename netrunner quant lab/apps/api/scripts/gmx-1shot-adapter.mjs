// GMX v2 → 1Shot adapter test. Builds a REAL GMX long via @gmx-io/sdk (correct live prices/market/
// execution fee), INTERCEPTS the SDK's send to capture the exact ExchangeRouter.multicall calldata +
// ETH value, then relays it through the 1Shot permissionless relayer as an EIP-7710 delegated
// execution (gas in USDC). Estimate-first (FREE, safe). Real send only when GMX_1SHOT_LIVE=1.
//
// Run from apps/api:  node scripts/gmx-1shot-adapter.mjs
// Env: MAINNET_TEST_PRIVATE_KEY (a PRE-UPGRADED 7702 DeleGator EOA), ARBITRUM_ONE_RPC_URL,
//      GMX_TEST_USDC (default 2), GMX_TEST_LEV_BPS (default 20000 = 2x), GMX_1SHOT_LIVE (1 to send).
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// The SDK's ESM build ships extensionless imports (bundler-targeted) that Node can't resolve, so use
// the CJS build — same as the backend (requireCjs("@gmx-io/sdk/v2")).
const { GmxSdk } = require("@gmx-io/sdk");
import { getSmartAccountsEnvironment, createDelegation, ScopeType, signDelegation } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi, formatUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const RELAYER = (process.env.ONESHOT_RELAYER_URL || "https://relayer.1shotapi.com/relayers").trim();
const CHAIN = 42161;
const RPC = (process.env.ARBITRUM_ONE_RPC_URL || "https://arb1.arbitrum.io/rpc").trim();
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const ETH_MARKET = getAddress("0x70d95587d40A2caf56bd97485aB3Eec10Bee6336"); // ETH/USD [WETH-USDC]
const COLLATERAL_USD = Number(process.env.GMX_TEST_USDC || "2");
const LEVERAGE_BPS = BigInt(process.env.GMX_TEST_LEV_BPS || "20000"); // 2x
const LIVE = process.env.GMX_1SHOT_LIVE === "1";

const PKraw = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim();
if (!PKraw) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
const pk = PKraw.startsWith("0x") ? PKraw : `0x${PKraw}`;
const account = privateKeyToAccount(pk);
const user = getAddress(account.address);
const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const MULTICALL_ABI = parseAbi(["function multicall(bytes[] data) payable returns (bytes[])"]);

let rpcId = 0;
async function rpc(m, p) {
  const r = await fetch(RELAYER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: m, params: p }) });
  const j = await r.json();
  if (j.error) throw new Error(`${m}: ${j.error.message}`);
  return j.result;
}
const bj = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

console.log("=== GMX → 1Shot adapter test ===");
console.log("account (must be a pre-upgraded 7702 SA):", user);
console.log(`order: LONG ETH · ${COLLATERAL_USD} USDC collateral · ${Number(LEVERAGE_BPS) / 10000}x · market ${ETH_MARKET}`);

// ---- 1. Build the real GMX multicall via the SDK, intercepting the send ----
const sdk = new GmxSdk({ chainId: CHAIN, account: user, rpcUrl: RPC, oracleUrl: "https://arbitrum-api.gmxinfra.io", subsquidUrl: "https://gmx.squids.live/gmx-synthetics-arbitrum:live/api/graphql" });
let captured = null;
sdk.callContract = async (address, _abi, method, params, opts) => {
  captured = { address: getAddress(address), method, params, value: BigInt(opts?.value ?? 0n) };
  throw new Error("__INTERCEPTED__");
};
try {
  await sdk.orders.long({
    payTokenAddress: USDC,
    collateralTokenAddress: USDC,
    marketAddress: ETH_MARKET,
    payAmount: BigInt(Math.round(COLLATERAL_USD * 1e6)),
    leverage: LEVERAGE_BPS,
    allowedSlippageBps: 100,
    skipSimulation: true,
  });
} catch (e) {
  if (e.message !== "__INTERCEPTED__") { console.error("SDK build failed:", e.message, "\n", (e.stack || "").split("\n").slice(0, 8).join("\n")); process.exit(1); }
}
if (!captured || captured.method !== "multicall") { console.error("did not capture ExchangeRouter.multicall; captured=", captured?.method); process.exit(1); }

const exchangeRouter = captured.address;
const executionFeeWei = captured.value;
const callData = encodeFunctionData({ abi: MULTICALL_ABI, functionName: "multicall", args: captured.params });
console.log("\n✓ captured real GMX calldata via SDK:");
console.log("  ExchangeRouter:", exchangeRouter);
console.log("  multicall legs:", captured.params[0].length, "(sendWnt + sendTokens + createOrder)");
console.log("  ETH execution fee (value):", formatUnits(executionFeeWei, 18), "ETH");
console.log("  calldata bytes:", (callData.length - 2) / 2);

// ---- 2. Open-ended delegation to the 1Shot redeemer (native value + allowed targets) ----
const env = getSmartAccountsEnvironment(CHAIN);
const caps = (await rpc("relayer_getCapabilities", [String(CHAIN)]))[String(CHAIN)];
const relayerTarget = getAddress(caps.targetAddress);
const feeCollector = getAddress(caps.feeCollector);
const now = Math.floor(Date.now() / 1000);
const fee = await rpc("relayer_getFeeData", { chainId: String(CHAIN), token: USDC });
const minFeeAtoms = BigInt(Math.ceil(Number(fee.minFee) * 1e6));

// FunctionCall scope is the right shape for a value-carrying CONTRACT CALL: it composes
// allowedTargets + allowedMethods + valueLte (and, unlike the NativeToken*Transfer scopes, does NOT
// impose an ExactCalldataEnforcer that would reject the GMX multicall). We restrict to exactly the two
// targets/methods this bundle uses — ExchangeRouter.multicall (value-carrying) and USDC.transfer (fee)
// — and cap native value to the execution fee + headroom. A timestamp caveat bounds the window.
const maxValue = executionFeeWei * 2n + 1000000000000000n; // executionFee headroom (~0.001 ETH)
const caveats = createCaveatBuilder(env)
  .addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 })
  .build();
const delegation = createDelegation({
  environment: env, from: user, to: relayerTarget,
  scope: { type: ScopeType.FunctionCall, targets: [exchangeRouter, USDC], selectors: ["multicall(bytes[])", "transfer(address,uint256)"], valueLte: { maxValue } },
  caveats,
});
const sig = await signDelegation({ privateKey: pk, delegation, delegationManager: env.DelegationManager, chainId: CHAIN });
const signed = { ...delegation, signature: sig };

// ---- 3. Executions: [USDC fee → feeCollector, GMX ExchangeRouter.multicall(value)] ----
const executions = [
  { target: USDC, value: "0x0", data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [feeCollector, minFeeAtoms] }) },
  { target: exchangeRouter, value: toHex(executionFeeWei), data: callData },
];
const bundle = bj({ chainId: String(CHAIN), transactions: [{ permissionContext: [signed], executions }], ...(fee.context ? { context: fee.context } : {}) });

// ---- 4. Estimate (FREE, safe) — proves 1Shot will relay the real GMX order ----
console.log("\n--- relayer_estimate7710Transaction (free) ---");
let est;
try { est = await rpc("relayer_estimate7710Transaction", bundle); }
catch (e) { console.error("estimate error:", e.message); process.exit(1); }
console.log("estimate:", JSON.stringify(est).slice(0, 320));
if (!est?.success) {
  console.log("\nRESULT: ✗ estimate did not pass. Inspect error above.");
  process.exit(0);
}
console.log("\nRESULT: ✓ 1Shot ACCEPTS the real GMX ExchangeRouter.multicall as a 7710 execution.");
const required = est.requiredPaymentAmount ? BigInt(est.requiredPaymentAmount) : minFeeAtoms;
console.log("requiredPaymentAmount (USDC fee):", formatUnits(required, 6));

// ---- 5. Live send (gated) ----
if (!LIVE) {
  console.log("\n(estimate-only. Set GMX_1SHOT_LIVE=1 + ensure the account holds USDC collateral + a little ETH + USDC.approve(GMX Router) to send for real.)");
  process.exit(0);
}
// Balance guard before spending.
const pc = createPublicClient({ chain: arbitrum, transport: http(RPC) });
const [ethBal, usdcBal] = await Promise.all([
  pc.getBalance({ address: user }),
  pc.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [user] }),
]);
console.log("\nbalances:", formatUnits(ethBal, 18), "ETH ·", formatUnits(usdcBal, 6), "USDC");
if (ethBal < executionFeeWei) { console.error("insufficient ETH for GMX keeper execution fee. Fund ~", formatUnits(executionFeeWei, 18), "ETH."); process.exit(1); }
if (usdcBal < BigInt(Math.round(COLLATERAL_USD * 1e6)) + required) { console.error("insufficient USDC (collateral + fee)."); process.exit(1); }

// Re-quote with the EXACT required payment for the send.
const sendExecutions = [
  { target: USDC, value: "0x0", data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [feeCollector, required] }) },
  { target: exchangeRouter, value: toHex(executionFeeWei), data: callData },
];
const sendBundle = bj({ chainId: String(CHAIN), transactions: [{ permissionContext: [signed], executions: sendExecutions }], ...(fee.context ? { context: fee.context } : {}) });
console.log("\n--- relayer_send7710Transaction (LIVE) ---");
const taskId = await rpc("relayer_send7710Transaction", sendBundle);
console.log("taskId:", taskId);
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  try { const st = await rpc("relayer_getStatus", [{ id: taskId, logs: true }]); console.log(`  [${i}]`, JSON.stringify(st).slice(0, 200)); if (JSON.stringify(st).match(/confirmed|success|mined|failed|revert/i)) break; } catch (e) { console.log(`  [${i}] status err: ${e.message.slice(0, 80)}`); }
}
console.log("\nVerify the order on https://arbiscan.io/tx/<hash> and GMX.");
