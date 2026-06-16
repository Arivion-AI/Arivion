// Circle CCTP v2 USDC bridge encoded for the 1Shot delegated relayer (gas in USDC, no native token).
// Burn USDC on the source chain (depositForBurn) -> Circle attests (~8-20s fast / ~13m standard) ->
// mint on the destination chain (receiveMessage). This is the cross-chain leg: e.g. move USDC from
// Arbitrum to Ethereum so the agent can LP on Ethereum, all from one up-front user authorization.
//
// CCTP v2 contracts (same address on every chain):
//   TokenMessengerV2     0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d  (depositForBurn)
//   MessageTransmitterV2 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64  (receiveMessage)
// Domains: Ethereum=0, Arbitrum=3. Attestation API: https://iris-api.circle.com

import { encodeFunctionData, parseAbi, getAddress, pad, type Address, type Hex } from "viem";
import type { Execution7710 } from "./oneShotRelayer.js";

export const TOKEN_MESSENGER_V2: Address = getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
export const MESSAGE_TRANSMITTER_V2: Address = getAddress("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
export const CCTP_DOMAIN: Record<number, number> = { 1: 0, 42161: 3, 8453: 6, 10: 2, 137: 7, 43114: 1 };
export const USDC_BY_CHAIN: Record<number, Address> = {
  1: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),       // Ethereum
  42161: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),   // Arbitrum
};
const IRIS_API = process.env.CCTP_IRIS_API ?? "https://iris-api.circle.com";

const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
// CCTP v2 depositForBurn (adds destinationCaller, maxFee, minFinalityThreshold vs v1).
const TM_ABI = parseAbi([
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold) returns (uint64)",
]);
const MT_ABI = parseAbi(["function receiveMessage(bytes message, bytes attestation) returns (bool)"]);

const addr32 = (a: string): Hex => pad(getAddress(a), { size: 32 });

export interface BridgeBurnPlan {
  srcChainId: number; dstChainId: number; srcDomain: number; dstDomain: number;
  tokenMessenger: Address; amountUsdc: string; mintRecipient: Address;
  fast: boolean; maxFee: string; note: string;
}
export interface BridgeBurnBuild { plan: BridgeBurnPlan; executions: Execution7710[] }

/** Build the source-chain burn executions [USDC.approve(TokenMessengerV2), depositForBurn]. The minted
 *  USDC goes to `mintRecipient` on the destination chain. `fast` uses CCTP v2 fast transfer (lower
 *  finality threshold, a small maxFee deducted from the amount); else standard (maxFee 0, ~13m). */
export function buildCctpBurn(opts: {
  srcChainId: number; dstChainId: number; usdcAmount: number; mintRecipient: string;
  fast?: boolean; maxFeeAtoms?: bigint;
}): BridgeBurnBuild {
  const srcDomain = CCTP_DOMAIN[opts.srcChainId];
  const dstDomain = CCTP_DOMAIN[opts.dstChainId];
  if (srcDomain == null || dstDomain == null) throw new Error("UNSUPPORTED_CCTP_CHAIN");
  const burnToken = USDC_BY_CHAIN[opts.srcChainId];
  if (!burnToken) throw new Error("NO_USDC_FOR_SRC_CHAIN");
  const amount = BigInt(Math.round(opts.usdcAmount * 1e6));
  const fast = opts.fast ?? true;
  const maxFee = fast ? (opts.maxFeeAtoms ?? amount / 1000n + 1n) : 0n; // fast: tiny fee from amount
  const minFinalityThreshold = fast ? 1000 : 2000; // 1000 = fast/soft, 2000 = standard/hard
  const mintRecipient = getAddress(opts.mintRecipient);

  const approveData = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [TOKEN_MESSENGER_V2, amount] }) as Hex;
  const burnData = encodeFunctionData({
    abi: TM_ABI, functionName: "depositForBurn",
    args: [amount, dstDomain, addr32(mintRecipient), burnToken, addr32("0x0000000000000000000000000000000000000000"), maxFee, minFinalityThreshold],
  }) as Hex;

  return {
    plan: {
      srcChainId: opts.srcChainId, dstChainId: opts.dstChainId, srcDomain, dstDomain,
      tokenMessenger: TOKEN_MESSENGER_V2, amountUsdc: amount.toString(), mintRecipient,
      fast, maxFee: maxFee.toString(),
      note: `CCTP ${fast ? "fast" : "standard"} bridge ${opts.usdcAmount} USDC: domain ${srcDomain} -> ${dstDomain}, mint to ${mintRecipient}.`,
    },
    executions: [
      { target: burnToken, value: "0x0", data: approveData },
      { target: TOKEN_MESSENGER_V2, value: "0x0", data: burnData },
    ],
  };
}

export interface CctpAttestation { status: string; message?: Hex; attestation?: Hex; eventNonce?: string }

/** Poll Circle's attestation service for the burn done in `burnTxHash` on `srcChainId`. Returns the
 *  message + attestation once "complete" (ready to mint on the destination). */
export async function fetchCctpAttestation(srcChainId: number, burnTxHash: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<CctpAttestation> {
  const srcDomain = CCTP_DOMAIN[srcChainId];
  if (srcDomain == null) throw new Error("UNSUPPORTED_CCTP_CHAIN");
  const deadline = Date.now() + (opts?.timeoutMs ?? 1_200_000); // up to 20m (standard finality)
  const interval = opts?.intervalMs ?? 4000;
  const url = `${IRIS_API}/v2/messages/${srcDomain}?transactionHash=${burnTxHash}`;
  while (Date.now() < deadline) {
    const r = await fetch(url).then((x) => x.json()).catch(() => null) as { messages?: Array<{ status?: string; message?: Hex; attestation?: Hex; eventNonce?: string }> } | null;
    const m = r?.messages?.[0];
    if (m?.status === "complete" && m.attestation && m.attestation !== "0x") {
      return { status: "complete", message: m.message, attestation: m.attestation, eventNonce: m.eventNonce };
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  return { status: "pending" };
}

/** Build the destination-chain mint execution [MessageTransmitterV2.receiveMessage(message, attestation)].
 *  Permissionless — any caller (here the 1Shot relayer) can submit it; USDC mints to the mintRecipient. */
export function buildCctpMint(message: Hex, attestation: Hex): { execution: Execution7710 } {
  const data = encodeFunctionData({ abi: MT_ABI, functionName: "receiveMessage", args: [message, attestation] }) as Hex;
  return { execution: { target: MESSAGE_TRANSMITTER_V2, value: "0x0", data } };
}
