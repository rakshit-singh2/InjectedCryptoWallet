// Minimal in-memory chrome.* stand-ins for unit tests. They model storage semantics only;
// browser behaviour (ports, windows, sender metadata) is covered by the Playwright suite.
import { Transaction } from 'ethers';
import { createWallet } from '../../src/background/wallet.js';

function createArea() {
  let data = {};
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (key in data) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(values) {
      data = { ...data, ...structuredClone(values) };
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    async setAccessLevel() {},
    dump: () => data,
    clear: () => {
      data = {};
    },
  };
}

export function installFakeChrome() {
  const chrome = {
    storage: { local: createArea(), session: createArea() },
    alarms: { create() {}, clear() {} },
    runtime: { id: 'test-extension', getURL: (path) => `chrome-extension://test-extension/${path}` },
    windows: {
      created: 0,
      shown: 0,
      async create() {
        chrome.windows.created += 1;
        chrome.windows.shown += 1;
        return { id: 76 + chrome.windows.created }; // first window is 77
      },
      async update() {
        chrome.windows.shown += 1;
      },
      async remove() {},
    },
  };
  globalThis.chrome = chrome;
  return chrome;
}

/** Simulates a JSON-RPC node. Records every call so tests can assert nothing was broadcast. */
export function createFakeRpc({ chainId = '0x1', baseFee = 10_000_000_000n } = {}) {
  const calls = [];
  const handlers = {
    eth_chainId: () => chainId,
    eth_blockNumber: () => '0x10',
    eth_estimateGas: () => '0x5208',
    eth_gasPrice: () => '0x3b9aca00',
    eth_maxPriorityFeePerGas: () => '0x59682f00',
    eth_getBlockByNumber: () => ({ number: '0x10', baseFeePerGas: `0x${baseFee.toString(16)}` }),
    eth_getTransactionCount: () => '0x7',
    eth_sendRawTransaction: ([raw]) => Transaction.from(raw).hash,
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const handler = handlers[body.method];
    const payload = handler
      ? { jsonrpc: '2.0', id: body.id, result: handler(body.params) }
      : { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } };
    return { status: 200, text: async () => JSON.stringify(payload) };
  };
  return { calls, handlers, fetchImpl };
}

export const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
export const TEST_PASSWORD = 'Correct-Horse-1';
export const ORIGIN = 'https://dapp.example';

export function createTestWallet(options = {}) {
  const chrome = installFakeChrome();
  const rpc = createFakeRpc(options.rpc);
  const notifications = [];
  const wallet = createWallet({
    kdfIterations: 1000,
    fetchImpl: rpc.fetchImpl,
    windows: chrome.windows,
    runtime: chrome.runtime,
    alarms: chrome.alarms,
    batchOptions: { pollMs: 5, receiptTimeoutMs: 2000, keepAlive() {}, ...options.batch },
    notifyTabs: async () => {
      notifications.push(Date.now());
    },
  });
  return { chrome, rpc, wallet, notifications };
}

/** Waits until an approval is queued and returns it. */
export async function nextApproval(wallet, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [first] = wallet.approvals.list();
    if (first) return first;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('No approval was requested');
}

export async function setupUnlockedWallet(options) {
  const context = createTestWallet(options);
  await context.wallet.popup.handle('createVault', { mnemonic: TEST_MNEMONIC, password: TEST_PASSWORD });
  return context;
}

/** Connects ORIGIN to the selected account through the real approval path. */
export async function connect(wallet, origin = ORIGIN) {
  const pending = wallet.provider.handle(origin, { method: 'eth_requestAccounts' });
  const approval = await nextApproval(wallet);
  const state = await wallet.popup.handle('getState');
  await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true, data: { accounts: [state.selectedAddress] } });
  return pending;
}
