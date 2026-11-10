import { JsonRpcProvider, formatEther } from 'ethers';

const cache = new Map();

/** Read-only provider for the popup's balance/token views. Chain ID is pinned so no network probing occurs. */
export function getReadProvider(network) {
  if (!network?.rpcUrl) {
    return null;
  }
  const key = `${network.chainId}|${network.rpcUrl}`;
  if (!cache.has(key)) {
    cache.set(key, new JsonRpcProvider(network.rpcUrl, Number(BigInt(network.chainId)), { staticNetwork: true }));
  }
  return cache.get(key);
}

export async function getNativeBalance(network, address) {
  const provider = getReadProvider(network);
  if (!provider || !address) {
    return null;
  }
  return formatEther(await provider.getBalance(address));
}

export function formatAmount(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '—';
  }
  return number.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
}

export function networkIcon(network) {
  return `svg/color/${(network?.icon || network?.ticker || 'generic').toLowerCase()}.svg`;
}
