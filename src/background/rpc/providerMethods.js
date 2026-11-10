import { TypedDataEncoder, getBytes, toUtf8String } from 'ethers';
import { WalletError, ErrorCodes, invalidParams, unauthorized, unsupported } from '../errors.js';
import { isHexData, normalizeAddress, normalizeChainId, requireParamsArray } from '../validation.js';
import { normalizeTransactionRequest } from '../controllers/TransactionController.js';
import { RateLimiter } from '../rateLimit.js';

// Read-only methods forwarded verbatim to the selected network's RPC. Anything not listed here or
// handled explicitly below is rejected with 4200.
export const PASSTHROUGH_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getUncleByBlockHashAndIndex',
  'eth_getUncleByBlockNumberAndIndex',
  'eth_getUncleCountByBlockHash',
  'eth_getUncleCountByBlockNumber',
  'eth_maxPriorityFeePerGas',
  'eth_protocolVersion',
  'eth_syncing',
  'net_listening',
  'net_peerCount',
  'web3_clientVersion',
  'web3_sha3',
]);

const REFUSED_METHODS = new Map([
  ['eth_sign', 'eth_sign is disabled because it can sign arbitrary transaction hashes. Use personal_sign or eth_signTypedData_v4.'],
  ['eth_signTransaction', 'Signing without broadcasting is not supported.'],
  ['eth_sendRawTransaction', 'Broadcasting externally signed transactions is not supported.'],
  ['eth_subscribe', 'Subscriptions are not supported; poll with eth_getLogs or eth_blockNumber.'],
  ['eth_unsubscribe', 'Subscriptions are not supported.'],
  // v1 (and the unversioned alias) has no domain separator: signatures are not bound to an app or chain.
  ['eth_signTypedData', 'Legacy typed data is not supported. Use eth_signTypedData_v4.'],
  ['eth_signTypedData_v1', 'Legacy typed data is not supported. Use eth_signTypedData_v4.'],
]);

const MAX_MESSAGE_BYTES = 64 * 1024;

/** Converts a personal_sign payload to bytes and a human-readable preview. */
export function decodePersonalMessage(message) {
  if (typeof message !== 'string') {
    throw invalidParams('Message must be a string.');
  }
  let bytes;
  if (isHexData(message)) {
    bytes = getBytes(message);
  } else {
    bytes = new TextEncoder().encode(message);
  }
  if (bytes.length > MAX_MESSAGE_BYTES) {
    throw invalidParams('Message is too large.');
  }
  let text = null;
  try {
    const decoded = toUtf8String(bytes);
    // Treat as text only if it has no control characters besides whitespace.
    // eslint-disable-next-line no-control-regex -- intentionally detects control characters
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) {
      text = decoded;
    }
  } catch {
    text = null;
  }
  return { bytes, preview: text ?? `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`, isText: text !== null };
}

/**
 * Returns a copy of `value` containing only the fields declared by `type`. EIP-712 hashing ignores
 * undeclared keys, so showing them in the approval UI would display text that is not signed.
 */
function pickTypedFields(types, type, value, path, stripped) {
  const arrayMatch = type.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) {
      throw invalidParams(`Typed data field ${path} must be an array.`);
    }
    return value.map((item, index) => pickTypedFields(types, arrayMatch[1], item, `${path}[${index}]`, stripped));
  }
  const fields = types[type];
  if (!fields) {
    return value; // atomic type; the encoder validates it
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(`Typed data field ${path} must be an object.`);
  }
  const declared = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) {
      stripped.push(path ? `${path}.${key}` : key);
    }
  }
  const result = {};
  for (const field of fields) {
    result[field.name] = pickTypedFields(types, field.type, value[field.name], path ? `${path}.${field.name}` : field.name, stripped);
  }
  return result;
}

/**
 * Parses and validates EIP-712 typed data. Domain chainId must match the selected network.
 * `version: 'v3'` additionally rejects arrays, which v3 cannot encode; without arrays v3 and v4
 * produce identical digests.
 */
export function parseTypedData(raw, chainId, { version = 'v4' } = {}) {
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_MESSAGE_BYTES * 2) {
      throw invalidParams('Typed data is too large.');
    }
    try {
      data = JSON.parse(raw);
    } catch {
      throw invalidParams('Typed data must be valid JSON.');
    }
  }
  if (!data || typeof data !== 'object' || typeof data.types !== 'object' || typeof data.primaryType !== 'string' ||
      typeof data.domain !== 'object' || data.domain === null || typeof data.message !== 'object' || data.message === null) {
    throw invalidParams('Typed data must include types, primaryType, domain and message.');
  }
  const { EIP712Domain: _domainType, ...types } = data.types;
  if (version === 'v3') {
    for (const fields of Object.values(types)) {
      if (Array.isArray(fields) && fields.some((field) => typeof field?.type === 'string' && field.type.includes('['))) {
        throw invalidParams('eth_signTypedData_v3 does not support arrays. Use eth_signTypedData_v4.');
      }
    }
  }
  let encoder;
  try {
    encoder = TypedDataEncoder.from(types);
  } catch (error) {
    throw invalidParams(`Invalid typed data types: ${error.shortMessage || error.message}`);
  }
  if (encoder.primaryType !== data.primaryType) {
    throw invalidParams('primaryType does not match the provided types.');
  }
  if (data.domain.chainId !== undefined && data.domain.chainId !== null) {
    let domainChain;
    try {
      domainChain = BigInt(data.domain.chainId);
    } catch {
      throw invalidParams('Typed data domain chainId is invalid.');
    }
    if (domainChain !== BigInt(chainId)) {
      throw invalidParams(`Typed data is for chain ${domainChain}, but the selected network is ${BigInt(chainId)}.`);
    }
  }
  const strippedFields = [];
  let message;
  try {
    message = pickTypedFields(types, data.primaryType, data.message, '', strippedFields);
    // Signing the reduced message yields the same digest as the original; verify that invariant.
    const digest = TypedDataEncoder.hash(data.domain, types, message);
    if (digest !== TypedDataEncoder.hash(data.domain, types, data.message)) {
      throw new Error('digest mismatch');
    }
  } catch (error) {
    if (error.code === ErrorCodes.invalidParams) {
      throw error;
    }
    throw invalidParams(`Typed data does not match its types: ${error.shortMessage || error.message}`);
  }
  return { domain: data.domain, types, primaryType: data.primaryType, message, strippedFields: strippedFields.slice(0, 20) };
}

export function createProviderHandler({ vault, network, permissions, approvals, transactions, batch, assets, rateLimiter = new RateLimiter() }) {
  async function requireConnectedAccount(origin, address) {
    const normalized = normalizeAddress(address);
    if (!(await vault.findAccount(normalized)) || !(await permissions.isPermitted(origin, normalized))) {
      throw unauthorized('This account has not been connected to this site. Call eth_requestAccounts first.');
    }
    return normalized;
  }

  async function connect(origin, { forcePrompt = false } = {}) {
    if (!(await vault.isInitialized())) {
      throw unauthorized('No wallet found. Create or import a wallet first.');
    }
    const existing = await permissions.getPermittedAccounts(origin);
    if (existing.length && !forcePrompt) {
      if (!(await vault.isUnlocked())) {
        await approvals.request({ origin, type: 'unlock', params: {}, exclusiveKey: `unlock:${origin}` });
      }
      return permissions.getPermittedAccounts(origin);
    }
    const decision = await approvals.request({ origin, type: 'connect', params: {}, exclusiveKey: `connect:${origin}` });
    const requested = Array.isArray(decision.accounts) ? decision.accounts : [];
    await permissions.grant(origin, requested);
    return permissions.getPermittedAccounts(origin);
  }

  async function switchChain(origin, chainIdParam) {
    const chainId = normalizeChainId(chainIdParam);
    const target = await network.getNetwork(chainId);
    if (!target) {
      throw new WalletError(ErrorCodes.unrecognizedChain, `Unrecognized chain ID ${chainId}. Try adding the chain with wallet_addEthereumChain first.`);
    }
    if ((await network.getSelectedChainId()) === chainId) {
      return null;
    }
    await approvals.request({
      origin,
      type: 'switchChain',
      params: { chainId, name: target.name, rpcUrl: target.rpcUrl },
      exclusiveKey: `chain:${origin}`,
    });
    await network.setSelectedChainId(chainId);
    return null;
  }

  async function signTypedData(origin, params, version) {
    const [address, typedData] = requireParamsArray(params, { min: 2, max: 2 });
    const from = await requireConnectedAccount(origin, address);
    const chainId = await network.getSelectedChainId();
    const parsed = parseTypedData(typedData, chainId, { version });
    await approvals.request({ origin, type: 'typedSign', params: { from, chainId, version, ...parsed } });
    if ((await network.getSelectedChainId()) !== chainId) {
      throw new WalletError(ErrorCodes.chainDisconnected, 'The network changed while the request was pending.');
    }
    const signer = await vault.getSigner(from);
    return signer.signTypedData(parsed.domain, parsed.types, parsed.message);
  }

  const handlers = {
    eth_chainId: async () => network.getSelectedChainId(),
    net_version: async () => BigInt(await network.getSelectedChainId()).toString(10),

    eth_accounts: async (origin) => ((await vault.isUnlocked()) ? permissions.getPermittedAccounts(origin) : []),
    eth_coinbase: async (origin) => ((await vault.isUnlocked()) ? (await permissions.getPermittedAccounts(origin))[0] ?? null : null),
    eth_requestAccounts: async (origin) => connect(origin),

    wallet_requestPermissions: async (origin, params) => {
      const [request] = requireParamsArray(params, { min: 1, max: 1 });
      const keys = request && typeof request === 'object' ? Object.keys(request) : [];
      if (keys.length !== 1 || keys[0] !== 'eth_accounts') {
        throw invalidParams('Only the eth_accounts permission can be requested.');
      }
      await connect(origin, { forcePrompt: true });
      return permissions.describe(origin);
    },
    // Like eth_accounts, reveal nothing about connected accounts while locked.
    wallet_getPermissions: async (origin) => ((await vault.isUnlocked()) ? permissions.describe(origin) : []),
    wallet_revokePermissions: async (origin, params) => {
      const [request] = requireParamsArray(params, { min: 1, max: 1 });
      if (!request || typeof request !== 'object' || !('eth_accounts' in request)) {
        throw invalidParams('Only the eth_accounts permission can be revoked.');
      }
      await permissions.revoke(origin);
      return null;
    },

    wallet_switchEthereumChain: async (origin, params) => {
      const [request] = requireParamsArray(params, { min: 1, max: 1 });
      return switchChain(origin, request?.chainId);
    },

    wallet_addEthereumChain: async (origin, params) => {
      const [request] = requireParamsArray(params, { min: 1, max: 1 });
      if (!request || typeof request !== 'object') {
        throw invalidParams('Expected a chain definition.');
      }
      const chainId = normalizeChainId(request.chainId);
      if (await network.getNetwork(chainId)) {
        return switchChain(origin, chainId);
      }
      if (request.nativeCurrency?.decimals !== undefined && request.nativeCurrency.decimals !== 18) {
        throw invalidParams('Only networks with an 18-decimal native currency are supported.');
      }
      const rpcUrl = Array.isArray(request.rpcUrls) ? request.rpcUrls.find((url) => typeof url === 'string') : undefined;
      const explorer = Array.isArray(request.blockExplorerUrls) ? request.blockExplorerUrls[0] : undefined;
      const candidate = await network.validateNetwork({
        chainId,
        name: request.chainName,
        ticker: request.nativeCurrency?.symbol,
        rpcUrl,
        blockExplorerUrl: explorer,
      });
      await approvals.request({ origin, type: 'addChain', params: { network: candidate }, exclusiveKey: `chain:${origin}` });
      await network.addNetwork(candidate, { verifyRpc: false });
      await network.setSelectedChainId(candidate.chainId);
      return null;
    },

    wallet_watchAsset: async (origin, params) => {
      const request = Array.isArray(params) ? params[0] : params;
      if (!request || request.type !== 'ERC20' || typeof request.options !== 'object' || request.options === null) {
        throw invalidParams('Only ERC20 assets are supported.');
      }
      const address = normalizeAddress(request.options.address, 'token address');
      const symbol = String(request.options.symbol ?? '').trim();
      const decimals = Number(request.options.decimals);
      if (!/^[\x21-\x7e]{1,11}$/.test(symbol)) {
        throw invalidParams('Token symbol must be 1-11 printable ASCII characters.');
      }
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw invalidParams('Token decimals must be an integer between 0 and 36.');
      }
      const chainId = await network.getSelectedChainId();
      const account = await vault.getSelectedAddress();
      if (!account) {
        throw unauthorized('No wallet account is available.');
      }
      await approvals.request({ origin, type: 'watchAsset', params: { address, symbol, decimals, chainId, account } });
      try {
        await assets.addToken(account, { address, symbol, name: symbol, decimals: String(decimals), chain: chainId });
      } catch {
        // Already watched: still a success from the dApp's perspective.
      }
      return true;
    },

    personal_sign: async (origin, params) => {
      const [message, address] = requireParamsArray(params, { min: 2, max: 3 });
      const from = await requireConnectedAccount(origin, address);
      const { preview, isText } = decodePersonalMessage(message);
      await approvals.request({ origin, type: 'personalSign', params: { from, preview, isText } });
      const signer = await vault.getSigner(from);
      return signer.signMessage(decodePersonalMessage(message).bytes);
    },

    eth_signTypedData_v4: async (origin, params) => signTypedData(origin, params, 'v4'),
    eth_signTypedData_v3: async (origin, params) => signTypedData(origin, params, 'v3'),

    eth_sendTransaction: async (origin, params) => {
      const [raw] = requireParamsArray(params, { min: 1, max: 1 });
      const chainId = await network.getSelectedChainId();
      const request = normalizeTransactionRequest(raw, { chainId });
      await requireConnectedAccount(origin, request.from);
      const proposal = Object.freeze(await transactions.prepare(request, chainId));
      const selected = await network.getNetwork(chainId);
      await approvals.request({
        origin,
        type: 'transaction',
        params: { ...proposal, networkName: selected?.name, ticker: selected?.ticker },
      });
      return transactions.signAndSend(proposal, { origin });
    },

    // EIP-5792. Batches run sequentially, never atomically; see BatchController.
    wallet_getCapabilities: async (origin, params) => batch.getCapabilities(origin, params),
    wallet_sendCalls: async (origin, params) => batch.sendCalls(origin, params),
    wallet_getCallsStatus: async (origin, params) => batch.getCallsStatus(origin, params),
  };

  return {
    async handle(origin, payload) {
      if (!payload || typeof payload !== 'object' || typeof payload.method !== 'string') {
        throw new WalletError(ErrorCodes.invalidRequest, 'Invalid request.');
      }
      const { method, params } = payload;
      if (!rateLimiter.take(origin)) {
        throw new WalletError(ErrorCodes.limitExceeded, 'Too many wallet requests from this site. Slow down and retry.');
      }
      if (REFUSED_METHODS.has(method)) {
        throw unsupported(REFUSED_METHODS.get(method));
      }
      if (Object.prototype.hasOwnProperty.call(handlers, method)) {
        return handlers[method](origin, params);
      }
      if (PASSTHROUGH_METHODS.has(method)) {
        return network.rpc(method, requireParamsArray(params, { max: 8 }));
      }
      throw unsupported(`Unsupported wallet method: ${method}`);
    },
  };
}

