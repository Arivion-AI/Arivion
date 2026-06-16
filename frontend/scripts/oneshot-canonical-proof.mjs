// Canonical end-to-end 1Shot proof through the PRODUCTION backend path. Exercises:
//   MetaMask Smart Account (kit, Stateless7702) -> EIP-7710 delegation (kit) -> backend /api/relay/send
//   which runs the canonical handshake getFeeData -> estimate7710 (requiredPaymentAmount) -> send with
//   the exact fee + signed context. Confirms on-chain. Local signer = signer-agnostic kit pattern.
//
//   SEND=1 node scripts/oneshot-canonical-proof.mjs   (real; ~$0.0217 USDC fee, self-transfer returns)
import { toMetaMaskSmartAccount, Implementation, getSmartAccountsEnvironment, createDelegation, ScopeType } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import { createPublicClient, http, getAddress, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const API = process.env.LAB_API ?? "http://localhost:4400";
const USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
const CHAIN = 42161;
const PK = (process.env.MAINNET_TEST_PRIVATE_KEY || "").trim();
if (!PK) { console.error("set MAINNET_TEST_PRIVATE_KEY"); process.exit(1); }
const pk = PK.startsWith("0x") ? PK : `0x${PK}`;
const account = privateKeyToAccount(pk);
const user = getAddress(account.address);
const publicClient = createPublicClient({ chain: arbitrum, transport: http() });

// SIWE login -> owner token.
const { nonce } = await (await fetch(`${API}/auth/nonce`)).json();
const msg = ["localhost:4400 wants you to sign in with your Ethereum account:", user, "", "canonical 1shot proof.", "", "URI: http://localhost:4400", "Version: 1", "Chain ID: 42161", `Nonce: ${nonce}`, `Issued At: ${new Date(1718409600000).toISOString()}`].join("\n");
const signature = await account.signMessage({ message: msg });
const { ownerToken } = await (await fetch(`${API}/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, signature }) })).json();
const H = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };

// Capabilities (relayer target) from the backend.
const caps = await (await fetch(`${API}/api/relay/capabilities`, { headers: H })).json();
const relayerTarget = getAddress(caps.targetAddress);
console.log("user:", user, "| relayer target:", relayerTarget, "| estFeeUsdc:", caps.estFeeUsdc);

// MetaMask Smart Account (Stateless7702) + delegation user -> relayer target.
const environment = getSmartAccountsEnvironment(CHAIN);
const sa = await toMetaMaskSmartAccount({ client: publicClient, implementation: Implementation.Stateless7702, address: user, signer: { account }, environment });
const now = Math.floor(Date.now() / 1000);
const selfAtoms = 50000n; // 0.05 USDC self-transfer (work)
const caveats = createCaveatBuilder(environment)
  .addCaveat("allowedTargets", { targets: [USDC] })
  .addCaveat("timestamp", { afterThreshold: now - 60, beforeThreshold: now + 3600 })
  .build();
const delegation = createDelegation({
  environment, from: user, to: relayerTarget,
  scope: { type: ScopeType.Erc20PeriodTransfer, tokenAddress: USDC, periodAmount: selfAtoms + 200000n, periodDuration: 86400, startDate: now - 60 },
  caveats,
});
const sig = await sa.signDelegation({ delegation, chainId: CHAIN });
const signedDelegation = { ...delegation, signature: sig };

const workExecutions = [{
  target: USDC, value: "0x0",
  data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [user, selfAtoms] }),
}];

if (process.env.SEND !== "1") { console.log("dry run (set SEND=1 to submit). delegation signed OK, sig bytes:", (sig.length - 2) / 2); process.exit(0); }

const before = await publicClient.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [user] });
console.log("USDC before:", (Number(before) / 1e6).toFixed(6), "→ POST /api/relay/send (canonical handshake)…");
const payload = JSON.parse(JSON.stringify({ permissionContext: [signedDelegation], workExecutions, kind: "relay_test_canonical" }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const res = await (await fetch(`${API}/api/relay/send`, { method: "POST", headers: H, body: JSON.stringify(payload) })).json();
console.log("send result:", JSON.stringify(res));
if (!res.ok) process.exit(1);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const after = await publicClient.readContract({ address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [user] });
  if (after !== before) { console.log(`LANDED ✓ taskId ${res.taskId} · fee ${res.feeUsdc} USDC · USDC ${(Number(before) / 1e6).toFixed(6)} → ${(Number(after) / 1e6).toFixed(6)} (Δ ${(Number(after - before) / 1e6).toFixed(6)})`); break; }
  if (i % 4 === 3) console.log(`  …waiting (${(i + 1) * 3}s)`);
}
