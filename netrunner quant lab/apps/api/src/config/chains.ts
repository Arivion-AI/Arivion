export type ChainRole = "none" | "market_data" | "reference" | "testnet";
export type ExecutionRole = "none" | "testnet" | "mainnet";

export type ChainConfig = {
  chainId: number;
  name: string;
  slug: string;
  kind: "evm";
  rpcUrlKey: string;
  wsUrlKey?: string;
  rpcUrl?: string;
  wsUrl?: string;
  explorerUrl: string;
  nativeCurrency: { symbol: string; decimals: number };
  isTestnet: boolean;
  dataRole: ChainRole;
  executionRole: ExecutionRole;
  capabilities: Record<string, boolean | string | number>;
};

export const DUALITY_CHAIN_IDS = {
  arbitrumOne: 42161,
  arbitrumSepolia: 421614,
  robinhoodTestnet: 46630,
} as const;

export function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envValue(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function dexDataEnabled(): boolean {
  return boolEnv("DUALITY_ENABLE_DEX_DATA", true);
}

export function testnetActionsEnabled(): boolean {
  return boolEnv("DUALITY_ENABLE_TESTNET_ACTIONS", false);
}

export function robinhoodTestnetEnabled(): boolean {
  return boolEnv("DUALITY_ENABLE_RH_TESTNET", true);
}

export function realTraderEnabled(): boolean {
  return boolEnv("DUALITY_ENABLE_REAL_TRADER", false);
}

export function defaultDataChainId(): number {
  return Number(process.env.DUALITY_DEX_DEFAULT_DATA_CHAIN_ID ?? DUALITY_CHAIN_IDS.arbitrumOne);
}

export function defaultTestExecutionChainId(): number {
  return Number(process.env.DUALITY_DEFAULT_TEST_EXEC_CHAIN_ID ?? DUALITY_CHAIN_IDS.arbitrumSepolia);
}

export function chainRegistry(): ChainConfig[] {
  return [
    {
      chainId: DUALITY_CHAIN_IDS.arbitrumOne,
      name: "Arbitrum One",
      slug: "arbitrum-one",
      kind: "evm",
      rpcUrlKey: "ARBITRUM_ONE_RPC_URL",
      wsUrlKey: "ARBITRUM_ONE_WS_URL",
      rpcUrl: envValue("ARBITRUM_ONE_RPC_URL"),
      wsUrl: envValue("ARBITRUM_ONE_WS_URL"),
      explorerUrl: "https://arbiscan.io",
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      isTestnet: false,
      dataRole: "market_data",
      executionRole: realTraderEnabled() ? "mainnet" : "none",
      capabilities: {
        dex_data: dexDataEnabled(),
        wallet_balances: true,
        gmx_live_trading: realTraderEnabled(),
        testnet_actions: false,
        data_only: !realTraderEnabled(),
      },
    },
    {
      chainId: DUALITY_CHAIN_IDS.arbitrumSepolia,
      name: "Arbitrum Sepolia",
      slug: "arbitrum-sepolia",
      kind: "evm",
      rpcUrlKey: "ARBITRUM_SEPOLIA_RPC_URL",
      wsUrlKey: "ARBITRUM_SEPOLIA_WS_URL",
      rpcUrl: envValue("ARBITRUM_SEPOLIA_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc"),
      wsUrl: envValue("ARBITRUM_SEPOLIA_WS_URL"),
      explorerUrl: "https://sepolia.arbiscan.io",
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      isTestnet: true,
      dataRole: "testnet",
      executionRole: "testnet",
      capabilities: {
        dex_data: false,
        wallet_balances: true,
        testnet_actions: testnetActionsEnabled(),
      },
    },
    {
      chainId: DUALITY_CHAIN_IDS.robinhoodTestnet,
      name: "Robinhood Chain Testnet",
      slug: "robinhood-testnet",
      kind: "evm",
      rpcUrlKey: "ROBINHOOD_TESTNET_RPC_URL",
      wsUrlKey: "ROBINHOOD_TESTNET_WS_URL",
      rpcUrl: envValue("ROBINHOOD_TESTNET_RPC_URL", "https://rpc.testnet.chain.robinhood.com"),
      wsUrl: envValue("ROBINHOOD_TESTNET_WS_URL", "wss://feed.testnet.chain.robinhood.com"),
      explorerUrl: "https://explorer.testnet.chain.robinhood.com",
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      isTestnet: true,
      dataRole: "testnet",
      executionRole: "testnet",
      capabilities: {
        wallet_balances: robinhoodTestnetEnabled(),
        test_stock_tokens: robinhoodTestnetEnabled(),
        testnet_actions: testnetActionsEnabled() && robinhoodTestnetEnabled(),
      },
    },
  ];
}

export function findChain(chainId: number): ChainConfig | undefined {
  return chainRegistry().find((chain) => chain.chainId === chainId);
}

export function publicChain(chain: ChainConfig): Omit<ChainConfig, "rpcUrl" | "wsUrl"> & {
  rpcConfigured: boolean;
  wsConfigured: boolean;
} {
  const { rpcUrl, wsUrl, ...rest } = chain;
  return { ...rest, rpcConfigured: Boolean(rpcUrl), wsConfigured: Boolean(wsUrl) };
}

export function isTestnetExecutionChain(chainId: number): boolean {
  const chain = findChain(chainId);
  return Boolean(chain?.isTestnet && chain.executionRole === "testnet");
}
