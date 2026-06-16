// Decisive 1Shot experiment: PRE-UPGRADE the EOA to a DeleGator (one-time self-sponsored EIP-7702
// Type-4 tx), then redeem a delegation through 1Shot WITHOUT an in-flight authorizationList. If the
// account already has DeleGator code, redeemDelegations should simulate + land (the in-flight-7702
// path that 1Shot couldn't simulate is avoided).
//
//   node scripts/oneshot-upgrade-test.mjs            # upgrade (if needed) + estimate only
//   SEND=1 node scripts/oneshot-upgrade-test.mjs     # + real 1Shot send (~$0.02 USDC) and verify on-chain
import { getSmartAccountsEnvironment, createDelegation, ScopeType, signDelegation } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { createWalletClient, createPublicClient, http, getAddress, encodeFunctionData, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const RELAYER = "https://relayer.1shotapi.com/relayers";
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const CHAIN = 42161;
const PK = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim();
if (!PK) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
const pk = PK.startsWith("0x") ? PK : `0x${PK}`;

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(RELAYER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message} ${JSON.stringify(j.error.data ?? "")}`);
  return j.result;
}

const account = privateKeyToAccount(pk);
const user = getAddress(account.address);
const publicClient = createPublicClient({ chain: arbitrum, transport: http() });
const walletClient = createWalletClient({ account, chain: arbitrum, transport: http() });
const env = getSmartAccountsEnvironment(CHAIN);
const impl = getAddress(env.implementations.EIP7702StatelessDeleGatorImpl);
console.log("user:", user, "| 7702 impl:", impl, "| DelegationManager:", env.DelegationManager);

// 0) Pre-upgrade the EOA if it has no code.
let code = await publicClient.getCode({ address: user });
if (!code || code === "0x") {
  const eth = await publicClient.getBalance({ address: user });
  console.log("EOA has no code; upgrading via self-sponsored 7702 Type-4 tx. ETH:", formatEther(eth));
  const auth = await walletClient.signAuthorization({ account, contractAddress: impl, executor: "self" });
  // Type-4 txs carry extra intrinsic gas per authorization (~25k); set an explicit limit so viem
  // doesn't under-estimate (empty-data self-call would otherwise estimate ~21k).
  const hash = await walletClient.sendTransaction({ authorizationList: [auth], to: user, value: 0n, data: "0x", gas: 200000n });
  console.log("upgrade tx:", hash, "→ waiting…");
  await publicClient.waitForTransactionReceipt({ hash });
  code = await publicClient.getCode({ address: user });
  console.log("post-upgrade code:", code && code !== "0x" ? code.slice(0, 26) + "… (UPGRADED)" : "STILL NONE");
} else {
  console.log("EOA already has code (upgraded):", code.slice(0, 26) + "…");
}
if (!code || code === "0x") { console.log("upgrade failed; aborting before any 1Shot spend."); process.exit(1); }

// 1) relayer target + feeCollector + fee.
const caps = (await rpc("relayer_getCapabilities", [String(CHAIN)]))[String(CHAIN)];
const relayerTarget = getAddress(caps.targetAddress);
const feeCollector = getAddress(caps.feeCollector);
const fee = await rpc("relayer_getFeeData", { chainId: String(CHAIN), token: USDC });
const feeUsdc = String(fee.minFee).includes(".") ? Number(fee.minFee) : Number(fee.minFee) / 1e6;
// Headroom over both minFee and the estimate's requiredPaymentAmount (~0.0217 USDC observed).
const feeAtoms = BigInt(Math.ceil((feeUsdc || 0.02) * 1e6) + 18000);
console.log("relayer:", relayerTarget, "| feeCollector:", feeCollector, "| feeAtoms:", feeAtoms.toString());

// 2) delegation user -> relayer target (no authorizationList; account already upgraded).
const now = Math.floor(Date.now() / 1000);
const selfAtoms = 50000n; // 0.05 USDC self-transfer
const caveats = createCaveatBuilder(env)
  .addCaveat("allowedTargets", { targets: [USDC] })
  .addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 })
  .build();
const delegation = createDelegation({
  environment: env, from: user, to: relayerTarget,
  scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: USDC, periodAmount: feeAtoms + selfAtoms + 1000n, periodDuration: 86400, startDate: now - 60 },
  caveats,
});
const signature = await signDelegation({ privateKey: pk, delegation, delegationManager: env.DelegationManager, chainId: CHAIN });
const signed = { ...delegation, signature };

const transfer = (to, amt) => encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [to, amt] });
const executions = [
  { target: USDC, value: "0x0", data: transfer(feeCollector, feeAtoms) },
  { target: USDC, value: "0x0", data: transfer(user, selfAtoms) },
];
const bundle = JSON.parse(JSON.stringify({ chainId: String(CHAIN), transactions: [{ permissionContext: [signed], executions }], ...(fee.context ? { context: fee.context } : {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

// 3) estimate (should now pass — account is upgraded).
console.log("\n--- estimate7710 (account pre-upgraded) ---");
try { console.log("estimate:", JSON.stringify(await rpc("relayer_estimate7710Transaction", bundle)).slice(0, 300)); }
catch (e) { console.log("ESTIMATE ERROR:", e.message.slice(0, 300)); }

// 4) optional real send + on-chain verification.
if (process.env.SEND === "1") {
  const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const before = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [user] });
  console.log("\n--- send7710 (REAL) --- USDC before:", (Number(before) / 1e6).toFixed(6));
  const taskId = await rpc("relayer_send7710Transaction", bundle);
  console.log("taskId:", taskId);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const after = await publicClient.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [user] });
    if (after !== before) { console.log(`LANDED ✓ USDC after: ${(Number(after) / 1e6).toFixed(6)} (Δ ${(Number(after - before) / 1e6).toFixed(6)})`); break; }
    if (i % 4 === 3) console.log(`  …waiting (${(i + 1) * 3}s), USDC still ${(Number(after) / 1e6).toFixed(6)}`);
  }
}
