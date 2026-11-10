import { AbiCoder, Transaction, formatEther, getAddress } from 'ethers';
import { WalletError, ErrorCodes, invalidParams } from '../errors.js';
import { isHexData, isHexQuantity, normalizeAddress, normalizeChainId } from '../validation.js';

const MAX_CALLDATA_BYTES = 128 * 1024;
const MAX_UINT256 = 2n ** 256n - 1n;
const GAS_LIMIT_CAP = 30_000_000n;
const DEFAULT_PRIORITY_FEE = 1_500_000_000n; // 1.5 gwei fallback when the node lacks eth_maxPriorityFeePerGas
const RECENT_NONCE_MS = 60_000;
const coder = AbiCoder.defaultAbiCoder();

function quantity(value, label, { max = MAX_UINT256 } = {}) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isHexQuantity(value)) {
    throw invalidParams(`${label} must be a hexadecimal quantity.`);
  }
  const parsed = BigInt(value);
  if (parsed > max) {
    throw invalidParams(`${label} is too large.`);
  }
  return parsed;
}

const hex = (value) => `0x${value.toString(16)}`;

/**
 * Validates and normalises an eth_sendTransaction object. Unknown fields are ignored; a dApp-supplied
 * nonce is ignored (the wallet assigns it at signing time) and a mismatching chainId is rejected.
 */
export function normalizeTransactionRequest(raw, { chainId }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParams('Transaction must be an object.');
  }
  const from = normalizeAddress(raw.from, 'from address');
  const to = raw.to === undefined || raw.to === null || raw.to === '' ? null : normalizeAddress(raw.to, 'to address');

  const data = raw.data ?? raw.input ?? '0x';
  if (raw.data !== undefined && raw.input !== undefined && raw.data !== raw.input) {
    throw invalidParams('Transaction data and input fields differ.');
  }
  if (!isHexData(data)) {
    throw invalidParams('Transaction data must be hex bytes.');
  }
  if ((data.length - 2) / 2 > MAX_CALLDATA_BYTES) {
    throw invalidParams('Transaction data is too large.');
  }
  if (!to && data === '0x') {
    throw invalidParams('Contract deployment requires data.');
  }

  if (raw.chainId !== undefined && normalizeChainId(raw.chainId) !== chainId) {
    throw invalidParams(`Transaction chainId ${raw.chainId} does not match the selected network ${chainId}.`);
  }
  if (Array.isArray(raw.accessList) && raw.accessList.length) {
    throw new WalletError(ErrorCodes.unsupportedMethod, 'Access-list transactions are not supported.');
  }
  if (raw.type !== undefined && !['0x0', '0x2'].includes(raw.type)) {
    throw new WalletError(ErrorCodes.unsupportedMethod, `Transaction type ${raw.type} is not supported.`);
  }

  const gasPrice = quantity(raw.gasPrice, 'gasPrice');
  const maxFeePerGas = quantity(raw.maxFeePerGas, 'maxFeePerGas');
  const maxPriorityFeePerGas = quantity(raw.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
  if (gasPrice !== undefined && (maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined)) {
    throw invalidParams('Specify either gasPrice or EIP-1559 fees, not both.');
  }
  if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas) {
    throw invalidParams('maxPriorityFeePerGas cannot exceed maxFeePerGas.');
  }

  const gasLimit = quantity(raw.gas ?? raw.gasLimit, 'gas', { max: GAS_LIMIT_CAP });
  return {
    from,
    to,
    value: quantity(raw.value ?? '0x0', 'value'),
    data: data.toLowerCase(),
    gasLimit,
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: raw.type === '0x0' || gasPrice !== undefined ? 0 : undefined,
  };
}

/** Best-effort decoding of the riskiest common calls so the approval screen can warn about them. */
export function describeCalldata(data) {
  if (!data || data === '0x') {
    return null;
  }
  const selector = data.slice(0, 10);
  const args = `0x${data.slice(10)}`;
  try {
    if (selector === '0x095ea7b3') {
      const [spender, amount] = coder.decode(['address', 'uint256'], args);
      return { kind: 'erc20-approve', spender: getAddress(spender), amount: amount.toString(), unlimited: amount === MAX_UINT256 };
    }
    if (selector === '0xa9059cbb') {
      const [recipient, amount] = coder.decode(['address', 'uint256'], args);
      return { kind: 'erc20-transfer', recipient: getAddress(recipient), amount: amount.toString() };
    }
    if (selector === '0xa22cb465') {
      const [operator, approved] = coder.decode(['address', 'bool'], args);
      return { kind: 'set-approval-for-all', operator: getAddress(operator), approved };
    }
  } catch {
    // fall through to a generic description
  }
  return { kind: 'contract-call', selector, bytes: (data.length - 2) / 2 };
}

export class TransactionController {
  constructor({ network, vault, history }) {
    this.network = network;
    this.vault = vault;
    this.history = history; // async (entry) => void
    this.locks = new Map();
    this.recentNonces = new Map();
  }

  /** Fills gas and fees using the selected network. Returns a serialisable, immutable proposal. */
  async prepare(request, chainId) {
    const callObject = {
      from: request.from,
      ...(request.to ? { to: request.to } : {}),
      value: hex(request.value),
      data: request.data,
    };

    let gasLimit = request.gasLimit;
    if (gasLimit === undefined) {
      const estimate = BigInt(await this.network.rpc('eth_estimateGas', [callObject], chainId));
      // Plain transfers are exact; contract calls get headroom for state changes between estimate and inclusion.
      gasLimit = request.data === '0x' ? estimate : (estimate * 120n) / 100n;
    }
    if (gasLimit > GAS_LIMIT_CAP) {
      throw invalidParams('Gas limit is too high.');
    }

    const fees = await this.resolveFees(request, chainId);
    const maxGasPrice = fees.type === 2 ? fees.maxFeePerGas : fees.gasPrice;
    const maxCost = request.value + gasLimit * maxGasPrice;

    return {
      chainId,
      from: request.from,
      to: request.to,
      value: hex(request.value),
      data: request.data,
      gasLimit: hex(gasLimit),
      ...(fees.type === 2
        ? { type: 2, maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas) }
        : { type: 0, gasPrice: hex(fees.gasPrice) }),
      display: {
        valueEther: formatEther(request.value),
        maxFeeEther: formatEther(gasLimit * maxGasPrice),
        maxTotalEther: formatEther(maxCost),
        calldata: describeCalldata(request.data),
      },
    };
  }

  async resolveFees(request, chainId) {
    if (request.type === 0) {
      const gasPrice = request.gasPrice ?? BigInt(await this.network.rpc('eth_gasPrice', [], chainId));
      return { type: 0, gasPrice };
    }
    const block = await this.network.rpc('eth_getBlockByNumber', ['latest', false], chainId);
    if (!block?.baseFeePerGas) {
      const gasPrice = BigInt(await this.network.rpc('eth_gasPrice', [], chainId));
      return { type: 0, gasPrice };
    }
    let priority = request.maxPriorityFeePerGas;
    if (priority === undefined) {
      try {
        priority = BigInt(await this.network.rpc('eth_maxPriorityFeePerGas', [], chainId));
      } catch {
        priority = DEFAULT_PRIORITY_FEE;
      }
    }
    const maxFee = request.maxFeePerGas ?? BigInt(block.baseFeePerGas) * 2n + priority;
    if (priority > maxFee) {
      priority = maxFee;
    }
    return { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
  }

  /** Runs `task` exclusively per account and chain, so concurrent sends never pick the same nonce. */
  async withAccountLock(key, task) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const current = previous.then(() => new Promise((resolve) => {
      release = resolve;
    }));
    this.locks.set(key, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Signs exactly the approved proposal (plus a fresh nonce) and broadcasts it.
   * `onSigned(hash)` runs before the broadcast so callers can record the hash first; if it throws,
   * nothing is broadcast. A failed broadcast is tagged `error.broadcast = 'rejected'` when the node
   * refused it (definitely not sent) or `'uncertain'` when it may have reached the network.
   */
  async signAndSend(proposal, { origin, onSigned } = {}) {
    const lockKey = `${proposal.chainId}:${proposal.from.toLowerCase()}`;
    return this.withAccountLock(lockKey, () => this.signAndSendLocked(proposal, { origin, onSigned, lockKey }));
  }

  async signAndSendLocked(proposal, { origin, onSigned, lockKey }) {
    const selectedChainId = await this.network.getSelectedChainId();
    if (selectedChainId !== proposal.chainId) {
      throw new WalletError(ErrorCodes.chainDisconnected, 'The network changed after this transaction was reviewed.');
    }
    const signer = await this.vault.getSigner(proposal.from);
    let nonce = Number(BigInt(await this.network.rpc('eth_getTransactionCount', [proposal.from, 'pending'], proposal.chainId)));
    // A load-balanced RPC may not count a transaction we sent moments ago; never reuse a recent nonce.
    const recent = this.recentNonces.get(lockKey);
    if (recent && Date.now() - recent.at < RECENT_NONCE_MS && recent.nonce >= nonce) {
      nonce = recent.nonce + 1;
    }

    const tx = Transaction.from({
      type: proposal.type,
      chainId: BigInt(proposal.chainId),
      nonce,
      to: proposal.to,
      value: BigInt(proposal.value),
      data: proposal.data,
      gasLimit: BigInt(proposal.gasLimit),
      ...(proposal.type === 2
        ? { maxFeePerGas: BigInt(proposal.maxFeePerGas), maxPriorityFeePerGas: BigInt(proposal.maxPriorityFeePerGas) }
        : { gasPrice: BigInt(proposal.gasPrice) }),
    });
    const signed = await signer.signTransaction(tx);
    const expectedHash = Transaction.from(signed).hash;
    await onSigned?.(expectedHash);
    let hash;
    try {
      hash = await this.network.rpc('eth_sendRawTransaction', [signed], proposal.chainId);
    } catch (error) {
      // Unreachable/invalid responses may still have reached the network; a node error is a refusal.
      // The nonce is not remembered here: if the tx never arrived, skipping it would leave a gap that
      // blocks every later transaction, while reusing it fails visibly (replacement underpriced).
      const uncertain = !(error instanceof WalletError) || [ErrorCodes.chainDisconnected, ErrorCodes.internal].includes(error.code);
      error.broadcast = uncertain ? 'uncertain' : 'rejected';
      throw error;
    }
    this.recentNonces.set(lockKey, { nonce, at: Date.now() });
    if (typeof hash !== 'string' || hash.toLowerCase() !== expectedHash.toLowerCase()) {
      const error = new WalletError(ErrorCodes.internal, 'The node returned an unexpected transaction hash.');
      error.broadcast = 'uncertain';
      throw error;
    }

    try {
      const network = await this.network.getNetwork(proposal.chainId);
      await this.history?.(proposal.from, {
        transactionHash: expectedHash,
        from: proposal.from,
        to: proposal.to || '',
        amount: proposal.display.valueEther,
        chainId: proposal.chainId,
        chainName: network?.name || proposal.chainId,
        origin,
        timestamp: Date.now(),
      });
    } catch {
      // History is a convenience; the broadcast already succeeded.
    }
    return expectedHash;
  }
}
