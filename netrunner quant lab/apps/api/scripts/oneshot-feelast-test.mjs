// Cross-validate the "self-funding bridge" idea: does the 1Shot relayer accept the USDC fee transfer
// when it is NOT the first execution? If yes, we can put the CCTP receiveMessage (which mints USDC)
// FIRST and pay the 1Shot fee from the freshly-minted balance — no Base pre-funding. FREE (estimate only).
import { getSmartAccountsEnvironment, createDelegation, ScopeType, signDelegation } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { getAddress, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RELAYER = (process.env.ONESHOT_RELAYER_URL || "https://relayer.1shotapi.com/relayers").trim();
const CHAIN = 42161;
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
let pk = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim(); if (!pk) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
if (!pk.startsWith("0x")) pk = `0x${pk}`;
const user = getAddress(privateKeyToAccount(pk).address);

let rpcId = 0;
async function rpc(m, p) { const r = await fetch(RELAYER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(`${m}: ${j.error.message}`); return j.result; }
const bj = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const xfer = (to, atoms) => ({ target: USDC, value: "0x0", data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, atoms] }) });

const env = getSmartAccountsEnvironment(CHAIN);
const caps = (await rpc("relayer_getCapabilities", [String(CHAIN)]))[String(CHAIN)];
const relayerTarget = getAddress(caps.targetAddress);
const feeCollector = getAddress(caps.feeCollector);
const fee = await rpc("relayer_getFeeData", { chainId: String(CHAIN), token: USDC });
const minFeeAtoms = BigInt(Math.ceil(Number(fee.minFee) * 1e6));
const now = Math.floor(Date.now() / 1000);

// Delegation that allows USDC.transfer calls (no native value). Same FunctionCall scope shape used by
// the GMX adapter — proven to pass 1Shot's enforcers.
const delegation = createDelegation({
  environment: env, from: user, to: relayerTarget,
  scope: { type: ScopeType.FunctionCall, targets: [USDC], selectors: ["transfer(address,uint256)"], valueLte: { maxValue: 0n } },
  caveats: createCaveatBuilder(env).addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 }).build(),
});
const signature = await signDelegation({ privateKey: pk, delegation, delegationManager: env.DelegationManager, chainId: CHAIN });
const signed = { ...delegation, signature };

// A benign "work" execution (1000-atom USDC self-transfer) standing in for receiveMessage, plus the fee.
const work = xfer(user, 1000n);
async function est(label, executions) {
  const bundle = bj({ chainId: String(CHAIN), transactions: [{ permissionContext: [signed], executions }], ...(fee.context ? { context: fee.context } : {}) });
  try { const r = await rpc("relayer_estimate7710Transaction", bundle); console.log(`${label}: success=${r.success}${r.success ? ` requiredPayment=${r.requiredPaymentAmount}` : ` error="${(r.error || "").slice(0, 120)}"`}`); return r.success; }
  catch (e) { console.log(`${label}: RPC error ${e.message.slice(0, 120)}`); return false; }
}

console.log("account:", user, "| minFee:", fee.minFee, "USDC\n");
const feeFirst = await est("FEE-FIRST  [fee, work]", [xfer(feeCollector, minFeeAtoms), work]);
const feeLast = await est("FEE-LAST   [work, fee]", [work, xfer(feeCollector, minFeeAtoms)]);
console.log("");
if (feeLast) console.log("RESULT: ✓ 1Shot accepts the fee transfer in a NON-FIRST position → self-funding mint-before-fee is valid.");
else if (feeFirst) console.log("RESULT: ✗ 1Shot REQUIRES fee-first → mint-before-fee won't work; the first Base mint is a genuine bootstrap edge (document for 1Shot).");
else console.log("RESULT: ? neither estimate passed — inspect errors above.");
