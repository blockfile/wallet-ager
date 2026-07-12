// Robinhood Chain network parameters.
// Robinhood Chain is an Arbitrum L2 with ETH as the native gas token.
export const NETWORKS = {
  mainnet: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    currency: "ETH",
  },
  testnet: {
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://robinhoodchain-testnet.blockscout.com",
    currency: "ETH",
  },
};

export function getNetwork(key) {
  const net = NETWORKS[key];
  if (!net) {
    const valid = Object.keys(NETWORKS).join(", ");
    throw new Error(`Unknown network "${key}". Use one of: ${valid}`);
  }
  return net;
}
