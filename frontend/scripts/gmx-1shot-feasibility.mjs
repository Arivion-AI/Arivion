// GMX + 1Shot feasibility test (FREE — estimate only, no spend). A GMX v2 order is an
// ExchangeRouter.multicall([sendWnt(executionFee), sendTokens(collateral), createOrder(params)]) call
// that carries an ETH `value` (GMX's keeper execution fee). 1Shot redeeming arbitrary USDC executions
// is already proven; the GMX-specific unknown is whether a 1Shot-redeemed execution can carry native
// ETH `value`. This estimates a native-value execution to confirm. If estimate.success === true, GMX
// is feasible via 1Shot (remaining work = encoding createOrder params + the ETH execution fee).
import { getSmartAccountsEnvironment, createDelegation, ScopeType, signDelegation } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const RELAYER = "https://relayer.1shotapi.com/relayers";
const CHAIN = 42161;
const GMX_EXCHANGE_ROUTER = getAddress("0x900173A66dbD345006C51fA35fA3aB760FcD843b"); // a GMX v2 ExchangeRouter (target illustration)
const PK = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim();
if (!PK) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
const pk = PK.startsWith("0x") ? PK : `0x${PK}`;
const account = privateKeyToAccount(pk);
const user = getAddress(account.address);

let rpcId = 0;
async function rpc(m, p) { const r = await fetch(RELAYER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${j.error.message}`); return j.result; }

const env = getSmartAccountsEnvironment(CHAIN);
const caps = (await rpc("relayer_getCapabilities", [String(CHAIN)]))[String(CHAIN)];
const relayerTarget = getAddress(caps.targetAddress);
const now = Math.floor(Date.now() / 1000);

// Native-token-scoped delegation allowing a small ETH value transfer to a target (here: self, as a
// stand-in for sendWnt to the GMX OrderVault). This tests value-carrying delegated execution.
const caveats = createCaveatBuilder(env).addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 }).build();
const delegation = createDelegation({
  environment: env, from: user, to: relayerTarget,
  scope: { type: ScopeType.NativeTokenPeriodTransfer, periodAmount: 1000000000000000n, periodDuration: 86400, startDate: now - 60 }, // 0.001 ETH/day
  caveats,
});
const sig = await signDelegation({ privateKey: pk, delegation, delegationManager: env.DelegationManager, chainId: CHAIN });
const signed = { ...delegation, signature: sig };

// Execution carrying ETH value (1000 wei) — the GMX-style "value" leg. Target = self (no-op transfer).
const executions = [{ target: user, value: "0x3e8", data: "0x" }];
const fee = await rpc("relayer_getFeeData", { chainId: String(CHAIN), token: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831") });
const bundle = JSON.parse(JSON.stringify({ chainId: String(CHAIN), transactions: [{ permissionContext: [signed], executions }], ...(fee.context ? { context: fee.context } : {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

console.log("user (7702 SA):", user, "| GMX feasibility = can a 1Shot-redeemed execution carry ETH value?");
try {
  const est = await rpc("relayer_estimate7710Transaction", bundle);
  console.log("estimate:", JSON.stringify(est).slice(0, 260));
  console.log(est.success ? "RESULT: ✓ native-value execution validates → GMX-via-1Shot is structurally FEASIBLE." : "RESULT: ✗ estimate failed: " + (est.error || "").slice(0, 160));
} catch (e) { console.log("RESULT: estimate error:", e.message.slice(0, 200)); }
