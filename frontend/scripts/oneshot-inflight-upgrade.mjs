// PROOF of requirement #2: upgrade a FRESH EOA to a smart account THROUGH the 1Shot relayer (in-flight
// EIP-7702), and execute — gas paid in USDC, the EOA holds ZERO ETH. The relayer submits one Type-4
// transaction that applies the authorizationList (upgrade) AND redeems the delegation in the same tx.
//
// Flow:
//   1. Generate a fresh keypair (no code, no ETH).
//   2. Fund it with a little USDC from MAINNET_TEST_PRIVATE_KEY (the only on-chain transfer; ~0.3 USDC).
//   3. Sign: a 7702 authorization (address = DeleGator IMPL) + an EIP-7710 delegation (fresh -> 1Shot target).
//   4. relayer_send7710Transaction with authorizationList (NO estimate — can't simulate the upgrade).
//   5. Confirm on-chain: the fresh EOA now has code 0xef0100… (UPGRADED) and USDC moved (fee paid).
import { getSmartAccountsEnvironment, createDelegation, ScopeType, signDelegation, toMetaMaskSmartAccount, Implementation } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { createPublicClient, createWalletClient, http, getAddress, encodeFunctionData, parseAbi, formatUnits } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arbitrum } from "viem/chains";

const RELAYER = "https://relayer.1shotapi.com/relayers";
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const CHAIN = 42161;
const FUNDER_PK = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim();
if (!FUNDER_PK) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
const funderPk = FUNDER_PK.startsWith("0x") ? FUNDER_PK : `0x${FUNDER_PK}`;

let rpcId = 0;
async function rpc(m, p) { const r = await fetch(RELAYER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${j.error.message} ${JSON.stringify(j.error.data ?? "")}`); return j.result; }

const pc = createPublicClient({ chain: arbitrum, transport: http() });
const usdcAbi = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const env = getSmartAccountsEnvironment(CHAIN);
const impl = getAddress(env.implementations.EIP7702StatelessDeleGatorImpl);

// 1. fresh EOA.
const freshPk = generatePrivateKey();
const fresh = privateKeyToAccount(freshPk);
const user = getAddress(fresh.address);
console.log("FRESH EOA:", user, "| 7702 impl:", impl);
console.log("pre-state: code =", (await pc.getCode({ address: user })) ?? "0x", "| ETH =", formatUnits(await pc.getBalance({ address: user }), 18));

// 2. fund it with USDC from the funder (the only direct on-chain tx).
const funder = privateKeyToAccount(funderPk);
const funderWallet = createWalletClient({ account: funder, chain: arbitrum, transport: http() });
const fundAtoms = 300000n; // 0.3 USDC (covers the 1Shot fee with headroom)
console.log(`funding fresh EOA with ${formatUnits(fundAtoms, 6)} USDC from ${funder.address}…`);
const fundHash = await funderWallet.writeContract({ address: USDC, abi: usdcAbi, functionName: "transfer", args: [user, fundAtoms] });
await pc.waitForTransactionReceipt({ hash: fundHash });
console.log("funded:", fundHash, "| fresh USDC =", formatUnits(await pc.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [user] }), 6), "| fresh ETH =", formatUnits(await pc.getBalance({ address: user }), 18), "(ZERO ETH)");

// 3. capabilities + delegation (fresh -> 1Shot relayer target) signed by the fresh key.
const caps = (await rpc("relayer_getCapabilities", [String(CHAIN)]))[String(CHAIN)];
const relayerTarget = getAddress(caps.targetAddress);
const feeCollector = getAddress(caps.feeCollector);
const fee = await rpc("relayer_getFeeData", { chainId: String(CHAIN), token: USDC });
const feeAtoms = BigInt(Math.ceil((String(fee.minFee).includes(".") ? Number(fee.minFee) : Number(fee.minFee) / 1e6) * 1e6) + 25000); // minFee + headroom
const now = Math.floor(Date.now() / 1000);
const caveats = createCaveatBuilder(env).addCaveat("allowedTargets", { targets: [USDC] }).addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 }).build();
const delegation = createDelegation({ environment: env, from: user, to: relayerTarget, scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: USDC, periodAmount: feeAtoms + 50000n, periodDuration: 86400, startDate: now - 60 }, caveats });
const sig = await signDelegation({ privateKey: freshPk, delegation, delegationManager: env.DelegationManager, chainId: CHAIN });
const signed = { ...delegation, signature: sig };

// 4. 7702 authorization (address = IMPL, recovered authority = fresh EOA). Relayer-sponsored: nonce = current (0).
const wc = createWalletClient({ account: fresh, chain: arbitrum, transport: http() });
const auth = await wc.signAuthorization({ account: fresh, contractAddress: impl, nonce: 0 });
const authorizationList = [{ address: getAddress(impl), chainId: CHAIN, nonce: 0, r: auth.r, s: auth.s, yParity: auth.yParity ?? 0 }];

// 5. send through 1Shot WITH authorizationList (in-flight upgrade) — NO estimate. Work = a 0.05 USDC self-transfer.
const transfer = (to, amt) => encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [to, amt] });
const executions = [{ target: USDC, value: "0x0", data: transfer(feeCollector, feeAtoms) }, { target: USDC, value: "0x0", data: transfer(user, 50000n) }];
const bundle = JSON.parse(JSON.stringify({ chainId: String(CHAIN), transactions: [{ permissionContext: [signed], executions }], authorizationList, ...(fee.context ? { context: fee.context } : {}) }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

console.log("\n--- relayer_send7710Transaction WITH authorizationList (in-flight upgrade through 1Shot, gas in USDC) ---");
const taskId = await rpc("relayer_send7710Transaction", bundle);
console.log("taskId:", taskId);
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const code = await pc.getCode({ address: user });
  if (code && code !== "0x") {
    console.log(`\n✓✓ UPGRADED THROUGH 1SHOT — fresh EOA code: ${code.slice(0, 26)}… (0xef0100 = EIP-7702 delegation designator)`);
    console.log(`   fresh USDC now: ${formatUnits(await pc.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [user] }), 6)} | fresh ETH: ${formatUnits(await pc.getBalance({ address: user }), 18)} (still ZERO — 1Shot paid gas in USDC)`);
    break;
  }
  if (i % 4 === 3) console.log(`  …waiting (${(i + 1) * 3}s), code still 0x`);
}
