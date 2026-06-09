"use client";

export type Eip1193Provider = {
  request: <T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<T>;
};

export type WalletChain = {
  chainId: number;
  name: string;
  nativeCurrency: { symbol: string; decimals: number };
  explorerUrl: string;
  rpcConfigured?: boolean;
  capabilities?: Record<string, boolean | string | number>;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

export function chainHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

function publicRpcUrls(chainId: number): string[] {
  if (chainId === 42161) return ["https://arb1.arbitrum.io/rpc"];
  if (chainId === 421614) return ["https://sepolia-rollup.arbitrum.io/rpc"];
  if (chainId === 46630) return ["https://rpc.testnet.chain.robinhood.com"];
  return [];
}

export async function connectInjectedWallet(): Promise<string> {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  const accounts = await window.ethereum.request<string[]>({ method: "eth_requestAccounts" });
  const address = accounts[0];
  if (!address) throw new Error("Wallet returned no account.");
  return address;
}

export async function switchOrAddChain(chain: WalletChain): Promise<void> {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  const hex = chainHex(chain.chainId);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: chain.name,
        rpcUrls: publicRpcUrls(chain.chainId),
        nativeCurrency: {
          name: chain.nativeCurrency.symbol,
          symbol: chain.nativeCurrency.symbol,
          decimals: chain.nativeCurrency.decimals,
        },
        blockExplorerUrls: [chain.explorerUrl].filter(Boolean),
      }],
    });
  }
}

export async function signWalletMessage(address: string, message: string): Promise<string> {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  return window.ethereum.request<string>({ method: "personal_sign", params: [message, address] });
}
