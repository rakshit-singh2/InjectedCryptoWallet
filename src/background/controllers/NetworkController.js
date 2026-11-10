import { builtInNetworkMap, DEFAULT_CHAIN_ID } from '../../shared/networks.js';
import { StorageKeys, getLocal, setLocal } from '../store.js';
import { WalletError, ErrorCodes, invalidParams } from '../errors.js';
import { normalizeChainId, normalizeExplorerUrl, normalizeRpcUrl, normalizeText } from '../validation.js';

const RPC_TIMEOUT_MS = 30_000;
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CUSTOM_NETWORKS = 50;
let rpcId = 0;

/** Reads a response body, aborting as soon as it exceeds `maxBytes` (a malicious RPC could stream forever). */
async function readBodyCapped(response, maxBytes) {
  const tooLarge = () => new WalletError(ErrorCodes.limitExceeded, 'The RPC response is too large.');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw tooLarge();
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Sends one JSON-RPC request. Errors from the node are surfaced with their code and message. */
export async function jsonRpc(rpcUrl, method, params = [], { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  const id = ++rpcId;
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new WalletError(ErrorCodes.chainDisconnected, 'The network RPC endpoint is unreachable.');
  } finally {
    clearTimeout(timer);
  }
  const text = await readBodyCapped(response, MAX_RPC_RESPONSE_BYTES);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WalletError(ErrorCodes.internal, `The RPC endpoint returned an invalid response (HTTP ${response.status}).`);
  }
  if (body?.error) {
    const code = Number.isInteger(body.error.code) ? body.error.code : ErrorCodes.internal;
    const message = typeof body.error.message === 'string' ? body.error.message.slice(0, 500) : 'RPC error.';
    const data = typeof body.error.data === 'string' && body.error.data.length <= 64 * 1024 ? body.error.data : undefined;
    throw new WalletError(code, message, data);
  }
  if (!body || !('result' in body)) {
    throw new WalletError(ErrorCodes.internal, 'The RPC endpoint returned no result.');
  }
  return body.result;
}

/** The single source of truth for networks and the selected chain. */
export class NetworkController {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    this.fetchImpl = fetchImpl;
    this.listeners = new Set();
  }

  onChainChanged(listener) {
    this.listeners.add(listener);
  }

  async getNetworks() {
    const stored = await getLocal(StorageKeys.networks);
    if (stored && typeof stored === 'object') {
      // Built-ins are read-only and defined in code: refresh saved copies so an endpoint fix in a
      // release reaches existing installs. Custom networks (builtIn: false) are never touched.
      let changed = false;
      const merged = { ...stored };
      for (const [chainId, network] of Object.entries(builtInNetworkMap())) {
        const saved = stored[chainId];
        if (saved && saved.builtIn && JSON.stringify(saved) !== JSON.stringify(network)) {
          merged[chainId] = network;
          changed = true;
        }
      }
      if (changed) {
        await setLocal({ [StorageKeys.networks]: merged });
      }
      return merged;
    }
    const defaults = builtInNetworkMap();
    await setLocal({ [StorageKeys.networks]: defaults });
    return defaults;
  }

  async getSelectedChainId() {
    const [networks, selected] = await Promise.all([this.getNetworks(), getLocal(StorageKeys.selectedChainId)]);
    if (selected && networks[selected]) {
      return selected;
    }
    return networks[DEFAULT_CHAIN_ID] ? DEFAULT_CHAIN_ID : Object.keys(networks)[0];
  }

  async getSelectedNetwork() {
    const networks = await this.getNetworks();
    return networks[await this.getSelectedChainId()];
  }

  async getNetwork(chainId) {
    return (await this.getNetworks())[normalizeChainId(chainId)] || null;
  }

  async setSelectedChainId(chainId) {
    const normalized = normalizeChainId(chainId);
    const networks = await this.getNetworks();
    if (!networks[normalized]) {
      throw new WalletError(ErrorCodes.unrecognizedChain, `Unrecognized chain ID ${normalized}.`);
    }
    const previous = await this.getSelectedChainId();
    await setLocal({ [StorageKeys.selectedChainId]: normalized });
    if (previous !== normalized) {
      for (const listener of this.listeners) {
        await listener(normalized);
      }
    }
    return normalized;
  }

  /** Validates a network definition without saving it. Confirms the RPC reports the declared chain ID. */
  async validateNetwork({ chainId, name, ticker, rpcUrl, blockExplorerUrl }, { verifyRpc = true } = {}) {
    const network = {
      chainId: normalizeChainId(chainId),
      name: normalizeText(name, 'Network name', { max: 64 }),
      ticker: normalizeText(ticker, 'Currency symbol', { min: 1, max: 12 }),
      rpcUrl: normalizeRpcUrl(rpcUrl),
      blockExplorerUrl: normalizeExplorerUrl(blockExplorerUrl),
      builtIn: false,
    };
    if (verifyRpc) {
      let reported;
      try {
        reported = await jsonRpc(network.rpcUrl, 'eth_chainId', [], { fetchImpl: this.fetchImpl });
      } catch {
        throw invalidParams('Could not reach the RPC URL to verify its chain ID.');
      }
      if (typeof reported !== 'string' || normalizeChainId(reported) !== network.chainId) {
        throw invalidParams(`The RPC URL reports chain ID ${String(reported)}, not ${network.chainId}.`);
      }
    }
    return network;
  }

  async addNetwork(definition, options) {
    const network = await this.validateNetwork(definition, options);
    const networks = await this.getNetworks();
    if (networks[network.chainId]) {
      throw invalidParams(`A network with chain ID ${network.chainId} already exists.`);
    }
    if (Object.values(networks).filter((n) => !n.builtIn).length >= MAX_CUSTOM_NETWORKS) {
      throw invalidParams('Custom network limit reached.');
    }
    await setLocal({ [StorageKeys.networks]: { ...networks, [network.chainId]: network } });
    return network;
  }

  async editNetwork(chainId, { name, ticker, rpcUrl, blockExplorerUrl }) {
    const networks = await this.getNetworks();
    const existing = networks[normalizeChainId(chainId)];
    if (!existing) {
      throw invalidParams('Unknown network.');
    }
    if (existing.builtIn) {
      throw invalidParams('Built-in networks cannot be edited. Add a custom network instead.');
    }
    const updated = await this.validateNetwork(
      { chainId: existing.chainId, name, ticker, rpcUrl: rpcUrl ?? existing.rpcUrl, blockExplorerUrl },
      { verifyRpc: rpcUrl !== undefined && rpcUrl !== existing.rpcUrl },
    );
    await setLocal({ [StorageKeys.networks]: { ...networks, [existing.chainId]: updated } });
    return updated;
  }

  async removeNetwork(chainId) {
    const networks = await this.getNetworks();
    const normalized = normalizeChainId(chainId);
    const existing = networks[normalized];
    if (!existing) {
      throw invalidParams('Unknown network.');
    }
    if (existing.builtIn) {
      throw invalidParams('Built-in networks cannot be removed.');
    }
    const wasSelected = (await this.getSelectedChainId()) === normalized;
    const { [normalized]: _removed, ...rest } = networks;
    await setLocal({ [StorageKeys.networks]: rest });
    if (wasSelected) {
      await this.setSelectedChainId(rest[DEFAULT_CHAIN_ID] ? DEFAULT_CHAIN_ID : Object.keys(rest)[0]);
    }
  }

  /** Forwards a JSON-RPC call to the selected (or given) network. */
  async rpc(method, params = [], chainId) {
    const network = chainId ? await this.getNetwork(chainId) : await this.getSelectedNetwork();
    if (!network) {
      throw new WalletError(ErrorCodes.chainDisconnected, 'No network is selected.');
    }
    return jsonRpc(network.rpcUrl, method, params, { fetchImpl: this.fetchImpl });
  }
}
