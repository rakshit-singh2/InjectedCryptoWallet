import { formatEther } from 'ethers';
import { WalletError, ErrorCodes, invalidParams, unauthorized } from '../errors.js';
import { StorageKeys, getSession, setSession } from '../store.js';
import { normalizeAddress, normalizeChainId, requireParamsArray } from '../validation.js';
import { describeCalldata, normalizeTransactionRequest } from './TransactionController.js';

export const CALLS_VERSION = '2.0.0';
export const CallsStatus = Object.freeze({
  pending: 100,
  confirmed: 200,
  offchainFailure: 400,
  reverted: 500,
  partiallyReverted: 600,
});

const MAX_CALLS = 10;
const MAX_BUNDLES = 100;
const MAX_ID_LENGTH = 4096;
const RECEIPT_POLL_MS = 2_000;
const RECEIPT_TIMEOUT_MS = 10 * 60 * 1000;
// Fees and gas approved up front are only trusted for this long; later calls get their own approval.
const PROPOSAL_FRESH_MS = 3 * 60 * 1000;
// A sent transaction with no receipt after this long (and no running batch) is treated as dropped.
const DROPPED_AFTER_MS = 30 * 60 * 1000;

/** Unknown capabilities fail the request unless the dApp marked them optional (EIP-5792). */
function checkCapabilities(capabilities, where) {
  if (capabilities === undefined || capabilities === null) {
    return;
  }
  if (typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw invalidParams(`${where} capabilities must be an object.`);
  }
  for (const [name, value] of Object.entries(capabilities)) {
    if (value?.optional !== true) {
      throw new WalletError(ErrorCodes.unsupportedCapability, `Unsupported capability: ${String(name).slice(0, 64)}.`);
    }
  }
}

/** Accepts only a mined receipt for exactly `hash`; a lying RPC cannot attribute another receipt. */
function minedReceipt(receipt, hash) {
  return receipt && typeof receipt === 'object' && receipt.blockHash &&
    typeof receipt.transactionHash === 'string' && receipt.transactionHash.toLowerCase() === hash.toLowerCase()
    ? receipt
    : null;
}

function toSpecReceipt(receipt) {
  return {
    logs: Array.isArray(receipt.logs)
      ? receipt.logs.map((log) => ({ address: log.address, data: log.data, topics: log.topics }))
      : [],
    status: receipt.status,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    transactionHash: receipt.transactionHash,
  };
}

const randomId = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

const maxFeeWei = (proposal) => BigInt(proposal.gasLimit) * BigInt(proposal.type === 2 ? proposal.maxFeePerGas : proposal.gasPrice);

/**
 * EIP-5792 call batches for externally owned accounts.
 *
 * Batches are NOT atomic: the calls are sent one after another, each only after the previous one is
 * mined successfully, and the batch stops at the first failure, rejection, lock, revoked connection or
 * network change. Calls that cannot be estimated before earlier calls are mined (e.g. approve → swap),
 * or whose approved fees have gone stale, get their own confirmation with exact fees at their turn,
 * so no fee is signed unseen.
 *
 * Bundle records hold only small public data (origin, hashes, per-hash success) in
 * chrome.storage.session; receipts and logs are fetched on demand. A hash is recorded *before* its
 * transaction is broadcast, so a crash can never report a sent transaction as "not sent". A restarted
 * worker never resumes an unfinished batch (fail closed).
 */
export class BatchController {
  constructor({ network, transactions, approvals, permissions, vault, pollMs = RECEIPT_POLL_MS, receiptTimeoutMs = RECEIPT_TIMEOUT_MS, keepAlive, now = () => Date.now() }) {
    this.network = network;
    this.transactions = transactions;
    this.approvals = approvals;
    this.permissions = permissions;
    this.vault = vault;
    this.pollMs = pollMs;
    this.receiptTimeoutMs = receiptTimeoutMs;
    this.now = now;
    // Extension API calls keep an MV3 worker alive while a batch waits for receipts.
    this.keepAlive = keepAlive ?? (() => globalThis.chrome?.runtime?.getPlatformInfo?.().catch?.(() => {}));
    this.bundles = null; // Map<key, record>
    this.loading = null;
    this.cancelled = new Set();
  }

  static key(origin, id) {
    return `${origin}\n${id}`;
  }

  /** Loads persisted bundles once per worker. Anything still "running" belonged to a dead worker. */
  async restore() {
    if (!this.loading) {
      this.loading = (async () => {
        const stored = (await getSession(StorageKeys.callBundles)) || [];
        this.bundles = new Map();
        for (const record of Array.isArray(stored) ? stored : []) {
          if (record && typeof record.origin === 'string' && typeof record.id === 'string' && Array.isArray(record.hashes)) {
            this.bundles.set(BatchController.key(record.origin, record.id), {
              ...record,
              results: record.results || {},
              sentAt: record.sentAt || {},
              running: false,
            });
          }
        }
        await this.persist();
      })();
    }
    return this.loading;
  }

  async persist() {
    const records = Array.from(this.bundles.values());
    // Evict the oldest finished bundles beyond the cap.
    while (records.length > MAX_BUNDLES) {
      const index = records.findIndex((record) => !record.running);
      if (index < 0) {
        break;
      }
      const [evicted] = records.splice(index, 1);
      this.bundles.delete(BatchController.key(evicted.origin, evicted.id));
    }
    await setSession({ [StorageKeys.callBundles]: records });
  }

  /** Stops every running batch before its next call (used on lock). */
  cancelAll() {
    for (const [key, record] of this.bundles || []) {
      if (record.running) {
        this.cancelled.add(key);
      }
    }
  }

  /** Running batches, for the popup's "Stop batch" control. Public data only. */
  async listRunning() {
    await this.restore();
    return Array.from(this.bundles.values())
      .filter((record) => record.running && !this.cancelled.has(BatchController.key(record.origin, record.id)))
      .map((record) => ({
        origin: record.origin,
        id: record.id,
        chainId: record.chainId,
        total: record.total,
        sent: record.hashes.length,
        confirmed: Object.values(record.results).filter((result) => result === '0x1').length,
      }));
  }

  /**
   * User-initiated stop: no further call is signed, and a pending step prompt is rejected.
   * Transactions already broadcast cannot be recalled; their receipts still count in the status.
   */
  async stop(origin, id) {
    await this.restore();
    const key = BatchController.key(origin, id);
    const record = this.bundles.get(key);
    if (!record?.running) {
      return false;
    }
    this.cancelled.add(key);
    for (const approval of this.approvals.list()) {
      if (approval.origin === origin && approval.type === 'transaction' && approval.params?.batch?.id === id) {
        this.approvals.settle(approval.id, false);
      }
    }
    return true;
  }

  /** When a site loses its connection, stop its batches and forget their status. */
  async handlePermissionChange(origin) {
    await this.restore();
    if ((await this.permissions.getPermittedAccounts(origin)).length) {
      return;
    }
    let changed = false;
    for (const [key, record] of this.bundles) {
      if (record.origin === origin) {
        this.cancelled.add(key);
        this.bundles.delete(key);
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  async getCapabilities(origin, params) {
    const [address, chainIds] = requireParamsArray(params, { min: 1, max: 2 });
    if (!(await this.vault.isUnlocked())) {
      throw unauthorized('The wallet is locked.');
    }
    const account = normalizeAddress(address);
    if (!(await this.permissions.isPermitted(origin, account))) {
      throw unauthorized('This account has not been connected to this site.');
    }
    const networks = await this.network.getNetworks();
    let requested = Object.keys(networks);
    if (chainIds !== undefined) {
      if (!Array.isArray(chainIds) || chainIds.length > 100) {
        throw invalidParams('chainIds must be an array.');
      }
      requested = chainIds.map((chainId) => normalizeChainId(chainId)).filter((chainId) => networks[chainId]);
    }
    return Object.fromEntries(requested.map((chainId) => [chainId, { atomic: { status: 'unsupported' } }]));
  }

  hasRunningBatch(origin) {
    return Array.from(this.bundles.values()).some((record) => record.origin === origin && record.running);
  }

  async sendCalls(origin, params) {
    await this.restore();
    const [request] = requireParamsArray(params, { min: 1, max: 1 });
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw invalidParams('Expected a calls request object.');
    }
    if (request.version !== CALLS_VERSION) {
      throw invalidParams(`Only wallet_sendCalls version ${CALLS_VERSION} is supported.`);
    }
    if (typeof request.atomicRequired !== 'boolean') {
      throw invalidParams('atomicRequired must be a boolean.');
    }
    if (request.atomicRequired) {
      throw new WalletError(ErrorCodes.atomicityUnsupported, 'This wallet cannot execute calls atomically.');
    }
    checkCapabilities(request.capabilities, 'Request');

    const chainId = await this.network.getSelectedChainId();
    let requestedChain;
    try {
      requestedChain = normalizeChainId(request.chainId);
    } catch {
      throw invalidParams('chainId is invalid.');
    }
    if (!(await this.network.getNetwork(requestedChain))) {
      throw new WalletError(ErrorCodes.unsupportedChainId, `Chain ${requestedChain} is not configured in this wallet.`);
    }
    if (requestedChain !== chainId) {
      throw invalidParams(`Calls are for chain ${requestedChain}, but the selected network is ${chainId}. Switch networks first.`);
    }

    if (!Array.isArray(request.calls) || request.calls.length === 0) {
      throw invalidParams('calls must be a non-empty array.');
    }
    if (request.calls.length > MAX_CALLS) {
      throw new WalletError(ErrorCodes.bundleTooLarge, `At most ${MAX_CALLS} calls are supported per batch.`);
    }

    let id = request.id;
    if (id !== undefined) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
        throw invalidParams(`id must be a string of at most ${MAX_ID_LENGTH} characters.`);
      }
      if (this.bundles.has(BatchController.key(origin, id))) {
        throw new WalletError(ErrorCodes.duplicateBundleId, 'A batch with this id already exists.');
      }
    } else {
      id = randomId();
    }
    if (this.hasRunningBatch(origin)) {
      throw new WalletError(ErrorCodes.resourceUnavailable, 'A batch from this site is still running.');
    }

    let from;
    if (request.from !== undefined && request.from !== null) {
      from = normalizeAddress(request.from, 'from address');
    } else {
      [from] = await this.permissions.getPermittedAccounts(origin);
    }
    if (!from || !(await this.vault.findAccount(from)) || !(await this.permissions.isPermitted(origin, from))) {
      throw unauthorized('This account has not been connected to this site. Call eth_requestAccounts first.');
    }

    const requests = request.calls.map((call, index) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) {
        throw invalidParams(`Call ${index + 1} must be an object.`);
      }
      checkCapabilities(call.capabilities, `Call ${index + 1}`);
      return normalizeTransactionRequest({ from, to: call.to, data: call.data, value: call.value }, { chainId });
    });

    // Refuse before estimating if the prompt would be refused anyway (one batch prompt per site),
    // so a site cannot turn wallet_sendCalls into a stream of RPC calls against the user's endpoint.
    const exclusiveKey = `batch:${origin}`;
    this.approvals.assertCanRequest(origin, exclusiveKey);

    // Estimate what can be estimated now. The first call must be estimable; later ones may depend on it.
    const steps = [];
    for (const [index, txRequest] of requests.entries()) {
      try {
        steps.push({ request: txRequest, proposal: Object.freeze(await this.transactions.prepare(txRequest, chainId)) });
      } catch (error) {
        if (index === 0) {
          throw error;
        }
        steps.push({ request: txRequest, proposal: null });
      }
    }

    const selected = await this.network.getNetwork(chainId);
    const knownFees = steps.filter((step) => step.proposal).reduce((sum, step) => sum + maxFeeWei(step.proposal), 0n);
    const totalValue = requests.reduce((sum, txRequest) => sum + txRequest.value, 0n);
    await this.approvals.request({
      origin,
      type: 'batch',
      exclusiveKey,
      params: {
        chainId,
        networkName: selected?.name,
        ticker: selected?.ticker,
        from,
        calls: steps.map(({ request: txRequest, proposal }) => ({
          to: txRequest.to,
          data: txRequest.data,
          valueEther: formatEther(txRequest.value),
          calldata: describeCalldata(txRequest.data),
          gasLimit: proposal?.gasLimit ?? null,
          maxFeeEther: proposal ? formatEther(maxFeeWei(proposal)) : null,
        })),
        totals: {
          valueEther: formatEther(totalValue),
          maxFeeEther: formatEther(knownFees),
          deferred: steps.filter((step) => !step.proposal).length,
        },
      },
    });

    // Re-check after the (possibly long) approval: another request may have claimed the id meanwhile.
    const key = BatchController.key(origin, id);
    if (this.bundles.has(key)) {
      throw new WalletError(ErrorCodes.duplicateBundleId, 'A batch with this id already exists.');
    }
    if (this.hasRunningBatch(origin)) {
      throw new WalletError(ErrorCodes.resourceUnavailable, 'A batch from this site is still running.');
    }
    const record = {
      id, origin, chainId, from,
      total: steps.length,
      hashes: [],
      results: {}, // hash -> receipt status ('0x1' | '0x0')
      sentAt: {}, // hash -> ms
      running: true,
      createdAt: this.now(),
    };
    this.bundles.set(key, record);
    try {
      await this.persist();
    } catch {
      this.bundles.delete(key);
      throw new WalletError(ErrorCodes.internal, 'Could not record the batch; nothing was sent.');
    }
    this.run(key, record, steps, this.now()).catch(() => {});
    return { id };
  }

  async shouldStop(key, record) {
    return this.cancelled.has(key) ||
      !(await this.vault.isUnlocked()) ||
      !(await this.permissions.isPermitted(record.origin, record.from)) ||
      (await this.network.getSelectedChainId()) !== record.chainId;
  }

  async run(key, record, steps, approvedAt) {
    try {
      for (const [index, step] of steps.entries()) {
        if (await this.shouldStop(key, record)) {
          return;
        }
        let proposal = step.proposal;
        if (proposal && index > 0 && this.now() - approvedAt > PROPOSAL_FRESH_MS) {
          proposal = null; // fees/gas approved earlier may be stale: re-estimate and ask again
        }
        if (!proposal) {
          proposal = Object.freeze(await this.transactions.prepare(step.request, record.chainId));
          const selected = await this.network.getNetwork(record.chainId);
          await this.approvals.request({
            origin: record.origin,
            type: 'transaction',
            params: { ...proposal, networkName: selected?.name, ticker: selected?.ticker, batch: { id: record.id, index: index + 1, total: steps.length } },
          });
          if (await this.shouldStop(key, record)) {
            return;
          }
        }
        let signedHash = null;
        let hash;
        try {
          hash = await this.transactions.signAndSend(proposal, {
            origin: record.origin,
            onSigned: async (signed) => {
              signedHash = signed;
              record.hashes.push(signed);
              record.sentAt[signed] = this.now();
              try {
                await this.persist();
              } catch (error) {
                record.hashes.pop();
                delete record.sentAt[signed];
                throw error; // not broadcast: signAndSend stops before sending
              }
            },
          });
        } catch (error) {
          if (signedHash && error.broadcast === 'rejected') {
            // The node refused it, so it is definitely not on chain.
            record.hashes = record.hashes.filter((sent) => sent !== signedHash);
            delete record.sentAt[signedHash];
          }
          throw error;
        }
        const receipt = await this.waitForReceipt(hash, record.chainId, key);
        if (!receipt) {
          return;
        }
        record.results[hash] = receipt.status;
        await this.persist();
        if (receipt.status !== '0x1') {
          return;
        }
      }
    } finally {
      record.running = false;
      this.cancelled.delete(key);
      await this.persist().catch(() => {});
    }
  }

  async fetchReceipt(hash, chainId) {
    return minedReceipt(await this.network.rpc('eth_getTransactionReceipt', [hash], chainId), hash);
  }

  async waitForReceipt(hash, chainId, key) {
    const deadline = this.now() + this.receiptTimeoutMs;
    // A stopped batch stops waiting; getCallsStatus still fetches this receipt live later.
    while (this.now() < deadline && !this.cancelled.has(key)) {
      try {
        const receipt = await this.fetchReceipt(hash, chainId);
        if (receipt) {
          return receipt;
        }
      } catch {
        // transient RPC failure: retry until the deadline
      }
      this.keepAlive();
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    return null;
  }

  async getCallsStatus(origin, params) {
    await this.restore();
    const [id] = requireParamsArray(params, { min: 1, max: 1 });
    if (typeof id !== 'string') {
      throw invalidParams('Expected a batch id.');
    }
    // Like eth_accounts: reveal nothing tied to the user's accounts while locked.
    if (!(await this.vault.isUnlocked())) {
      throw unauthorized('The wallet is locked.');
    }
    const record = this.bundles.get(BatchController.key(origin, id));
    if (!record) {
      throw new WalletError(ErrorCodes.unknownBundleId, 'Unknown batch id.');
    }
    // Receipts (with logs) are fetched live rather than stored, keeping session storage small.
    const receipts = new Map();
    for (const hash of record.hashes) {
      try {
        const receipt = await this.fetchReceipt(hash, record.chainId);
        if (receipt) {
          receipts.set(hash, receipt);
        }
      } catch {
        // leave pending
      }
    }
    return {
      version: CALLS_VERSION,
      id: record.id,
      chainId: record.chainId,
      atomic: false,
      status: this.status(record, receipts),
      receipts: record.hashes.filter((hash) => receipts.has(hash)).map((hash) => toSpecReceipt(receipts.get(hash))),
    };
  }

  status(record, receipts) {
    if (record.running) {
      return CallsStatus.pending;
    }
    const waiting = record.hashes.some((hash) => !receipts.has(hash) && this.now() - (record.sentAt[hash] ?? 0) < DROPPED_AFTER_MS);
    if (waiting) {
      return CallsStatus.pending;
    }
    if (record.hashes.length === 0) {
      return CallsStatus.offchainFailure;
    }
    const succeeded = Array.from(receipts.values()).filter((receipt) => receipt.status === '0x1').length;
    if (record.hashes.length === record.total && succeeded === record.total) {
      return CallsStatus.confirmed;
    }
    return succeeded === 0 ? CallsStatus.reverted : CallsStatus.partiallyReverted;
  }
}
