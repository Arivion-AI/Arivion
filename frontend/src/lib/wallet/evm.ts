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

// EIP-6963 multi-injected-provider discovery. When several wallets are installed (e.g. MetaMask AND
// MetaMask Flask), `window.ethereum` is ambiguous; EIP-6963 enumerates them by `rdns`. We PREFER
// MetaMask Flask (`io.metamask.flask`) because ERC-7715 Advanced Permissions is Flask-only, then fall
// back to regular MetaMask (`io.metamask`), then any announced provider, then `window.ethereum`.
const FLASK_RDNS = "io.metamask.flask";
const METAMASK_RDNS = "io.metamask";
type Eip6963Detail = { info?: { rdns?: string; name?: string }; provider?: Eip1193Provider };
const discoveredProviders = new Map<string, Eip1193Provider>();
function requestEip6963(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const d = (event as CustomEvent<Eip6963Detail>).detail;
    if (d?.info?.rdns && d.provider) discoveredProviders.set(d.info.rdns, d.provider);
  });
  requestEip6963(); // kick discovery at load; providers announce synchronously in response
}

/** The preferred injected provider: MetaMask Flask > MetaMask > any announced > window.ethereum. */
export function preferredProvider(): Eip1193Provider | undefined {
  requestEip6963(); // re-poll to catch wallets injected after load
  return (
    discoveredProviders.get(FLASK_RDNS) ??
    discoveredProviders.get(METAMASK_RDNS) ??
    (discoveredProviders.size > 0 ? [...discoveredProviders.values()][0] : undefined) ??
    (typeof window !== "undefined" ? window.ethereum : undefined)
  );
}

/** Whether MetaMask Flask is one of the discovered providers (ERC-7715 Advanced Permissions capable). */
export function isFlaskAvailable(): boolean {
  requestEip6963();
  return discoveredProviders.has(FLASK_RDNS);
}

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && Boolean(preferredProvider());
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
  const provider = preferredProvider();
  if (!provider) throw new Error("No injected wallet found.");
  const accounts = await provider.request<string[]>({ method: "eth_requestAccounts" });
  const address = accounts[0];
  if (!address) throw new Error("Wallet returned no account.");
  return address;
}

export async function switchOrAddChain(chain: WalletChain): Promise<void> {
  const provider = preferredProvider();
  if (!provider) throw new Error("No injected wallet found.");
  const hex = chainHex(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;
    await provider.request({
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
  const provider = preferredProvider();
  if (!provider) throw new Error("No injected wallet found.");
  return provider.request<string>({ method: "personal_sign", params: [message, address] });
}
