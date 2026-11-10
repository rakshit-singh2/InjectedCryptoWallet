// Built-in networks. Chain IDs are hard-coded rather than read from the RPC, so a
// misbehaving endpoint cannot make the wallet believe it is on a different chain.
// RPC URLs are public, key-less endpoints; users can add their own provider as a custom network.

export const DEFAULT_CHAIN_ID = '0x1';

export const BUILT_IN_NETWORKS = Object.freeze([
  {
    chainId: '0x1',
    name: 'Ethereum',
    ticker: 'ETH',
    icon: 'eth',
    rpcUrl: 'https://rpc.mevblocker.io',
    blockExplorerUrl: 'https://etherscan.io',
    builtIn: true,
  },
  {
    chainId: '0xaa36a7',
    name: 'Ethereum Sepolia',
    ticker: 'ETH',
    icon: 'eth',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    blockExplorerUrl: 'https://sepolia.etherscan.io',
    builtIn: true,
  },
  {
    chainId: '0x89',
    name: 'Polygon',
    ticker: 'POL',
    icon: 'matic',
    // polygon-rpc.com began requiring an API key (HTTP 403, 2026-11); publicnode is key-less.
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    blockExplorerUrl: 'https://polygonscan.com',
    builtIn: true,
  },
  {
    chainId: '0x13882',
    name: 'Polygon Amoy',
    ticker: 'POL',
    icon: 'matic',
    rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com',
    blockExplorerUrl: 'https://amoy.polygonscan.com',
    builtIn: true,
  },
]);

export function builtInNetworkMap() {
  return Object.fromEntries(BUILT_IN_NETWORKS.map((network) => [network.chainId, { ...network }]));
}
