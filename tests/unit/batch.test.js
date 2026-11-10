import { describe, expect, it } from 'vitest';
import { Transaction, verifyTypedData } from 'ethers';
import { ORIGIN, TEST_PASSWORD, connect, nextApproval, setupUnlockedWallet } from './helpers.js';
import { BatchController } from '../../src/background/controllers/BatchController.js';

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CAROL = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const OTHER = 'https://evil.example';

async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Fake chain: sequential nonces, a receipt per broadcast; `revert` lists recipients whose tx reverts. */
function simulateChain(rpc, { revert = new Set(), mine = true } = {}) {
  const sent = [];
  const receipts = new Map();
  rpc.handlers.eth_getTransactionCount = () => `0x${(7 + sent.length).toString(16)}`;
  rpc.handlers.eth_sendRawTransaction = ([raw]) => {
    const tx = Transaction.from(raw);
    sent.push(tx);
    if (mine) {
      receipts.set(tx.hash, {
        transactionHash: tx.hash,
        blockHash: `0x${'ab'.repeat(32)}`,
        blockNumber: '0x11',
        gasUsed: '0x5208',
        status: revert.has(tx.to) ? '0x0' : '0x1',
        logs: [],
      });
    }
    return tx.hash;
  };
  rpc.handlers.eth_getTransactionReceipt = ([hash]) => receipts.get(hash) ?? null;
  return { sent, receipts };
}

const calls = (...recipients) => recipients.map((to) => ({ to, value: '0x1' }));
const sendCallsRequest = (overrides = {}) => ({ version: '2.0.0', chainId: '0x1', from: ACCOUNT, atomicRequired: false, calls: calls(BOB, CAROL), ...overrides });

async function status(wallet, id, origin = ORIGIN) {
  return wallet.provider.handle(origin, { method: 'wallet_getCallsStatus', params: [id] });
}

async function finalStatus(wallet, id) {
  return waitFor(async () => {
    const result = await status(wallet, id);
    return result.status !== 100 ? result : null;
  });
}

describe('eth_signTypedData_v3', () => {
  const v3Data = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'contents', type: 'string' }],
    },
    primaryType: 'Mail',
    domain: { name: 'Test', chainId: 1 },
    message: { from: { name: 'Cow', wallet: BOB }, contents: 'Hello' },
  };

  it('signs array-free typed data after approval, with the same digest as v4', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v3', params: [ACCOUNT, JSON.stringify(v3Data)] });
    const approval = await nextApproval(wallet);
    expect(approval).toMatchObject({ type: 'typedSign', params: { version: 'v3', primaryType: 'Mail' } });
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    const { EIP712Domain: _domain, ...types } = v3Data.types;
    expect(verifyTypedData(v3Data.domain, types, v3Data.message, await pending)).toBe(ACCOUNT);
  });

  it('rejects arrays, wrong chains and unconnected accounts before prompting', async () => {
    const { wallet, chrome } = await setupUnlockedWallet();
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v3', params: [ACCOUNT, JSON.stringify(v3Data)] })).rejects.toMatchObject({ code: 4100 });
    await connect(wallet);
    const shown = chrome.windows.shown;
    const withArray = structuredClone(v3Data);
    withArray.types.Mail.push({ name: 'cc', type: 'Person[]' });
    withArray.message.cc = [];
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v3', params: [ACCOUNT, JSON.stringify(withArray)] })).rejects.toMatchObject({ code: -32602 });
    const wrongChain = { ...v3Data, domain: { name: 'Test', chainId: 137 } };
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v3', params: [ACCOUNT, JSON.stringify(wrongChain)] })).rejects.toMatchObject({ code: -32602 });
    expect(chrome.windows.shown).toBe(shown);
  });

  it('still refuses v1 and the unversioned method (no domain binding)', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    const legacy = [{ type: 'string', name: 'message', value: 'hi' }];
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v1', params: [legacy, ACCOUNT] })).rejects.toMatchObject({ code: 4200 });
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData', params: [legacy, ACCOUNT] })).rejects.toMatchObject({ code: 4200 });
  });
});

describe('wallet_getCapabilities', () => {
  it('reports non-atomic execution only to connected sites while unlocked', async () => {
    const { wallet } = await setupUnlockedWallet();
    await expect(wallet.provider.handle(ORIGIN, { method: 'wallet_getCapabilities', params: [ACCOUNT] })).rejects.toMatchObject({ code: 4100 });
    await connect(wallet);
    const all = await wallet.provider.handle(ORIGIN, { method: 'wallet_getCapabilities', params: [ACCOUNT] });
    expect(all['0x1']).toEqual({ atomic: { status: 'unsupported' } });
    expect(await wallet.provider.handle(ORIGIN, { method: 'wallet_getCapabilities', params: [ACCOUNT, ['0x1', '0x999']] })).toEqual({
      '0x1': { atomic: { status: 'unsupported' } },
    });
    await wallet.vault.lock();
    await expect(wallet.provider.handle(ORIGIN, { method: 'wallet_getCapabilities', params: [ACCOUNT] })).rejects.toMatchObject({ code: 4100 });
  });
});

describe('wallet_sendCalls', () => {
  it('validates requests before prompting', async () => {
    const { wallet, chrome } = await setupUnlockedWallet();
    const send = (request) => wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [request] });
    await expect(send(sendCallsRequest())).rejects.toMatchObject({ code: 4100 });
    await connect(wallet);
    const shown = chrome.windows.shown;
    await expect(send(sendCallsRequest({ atomicRequired: true }))).rejects.toMatchObject({ code: 5760 });
    await expect(send(sendCallsRequest({ atomicRequired: undefined }))).rejects.toMatchObject({ code: -32602 });
    await expect(send(sendCallsRequest({ version: '1.0' }))).rejects.toMatchObject({ code: -32602 });
    await expect(send(sendCallsRequest({ capabilities: { paymasterService: { url: 'https://x' } } }))).rejects.toMatchObject({ code: 5700 });
    await expect(send(sendCallsRequest({ calls: [{ to: BOB, capabilities: { auxiliaryFunds: {} } }] }))).rejects.toMatchObject({ code: 5700 });
    await expect(send(sendCallsRequest({ calls: calls(...Array(11).fill(BOB)) }))).rejects.toMatchObject({ code: 5740 });
    await expect(send(sendCallsRequest({ calls: [] }))).rejects.toMatchObject({ code: -32602 });
    await expect(send(sendCallsRequest({ chainId: '0x999' }))).rejects.toMatchObject({ code: 5710 });
    await expect(send(sendCallsRequest({ chainId: '0x89' }))).rejects.toMatchObject({ code: -32602 });
    await expect(send(sendCallsRequest({ calls: [{ to: BOB, value: '12' }] }))).rejects.toMatchObject({ code: -32602 });
    await expect(send(sendCallsRequest({ from: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' }))).rejects.toMatchObject({ code: 4100 });
    expect(chrome.windows.shown).toBe(shown);
  });

  it('never broadcasts when the batch is rejected', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: false });
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    expect(chain.sent).toHaveLength(0);
  });

  it('shows every call in one approval, then sends them in order with sequential nonces', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    const unlimitedApprove = `0x095ea7b3${BOB.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}`;
    const request = sendCallsRequest({ id: 'dapp-batch-1', calls: [{ to: CAROL, data: unlimitedApprove }, { to: BOB, value: '0xde0b6b3a7640000' }] });
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [request] });
    const approval = await nextApproval(wallet);
    expect(approval.type).toBe('batch');
    expect(approval.params.calls).toHaveLength(2);
    expect(approval.params.calls[0].calldata).toMatchObject({ kind: 'erc20-approve', unlimited: true });
    expect(approval.params.totals).toMatchObject({ valueEther: '1.0', deferred: 0 });
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    expect(await pending).toEqual({ id: 'dapp-batch-1' });

    const result = await finalStatus(wallet, 'dapp-batch-1');
    expect(result).toMatchObject({ version: '2.0.0', id: 'dapp-batch-1', chainId: '0x1', atomic: false, status: 200 });
    expect(result.receipts.map((receipt) => receipt.transactionHash)).toEqual(chain.sent.map((tx) => tx.hash));
    expect(chain.sent.map((tx) => [tx.to, tx.nonce, tx.from])).toEqual([[CAROL, 7, ACCOUNT], [BOB, 8, ACCOUNT]]);
    expect(chain.sent[0].data).toBe(unlimitedApprove);

    // The id is per-site and cannot be reused.
    await expect(status(wallet, 'dapp-batch-1', OTHER)).rejects.toMatchObject({ code: 5730 });
    await expect(wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [request] })).rejects.toMatchObject({ code: 5720 });
  });

  it('stops at the first revert (status 500 when nothing succeeded, 600 when some did)', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc, { revert: new Set([BOB]) });

    const first = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest({ calls: calls(BOB, CAROL) })] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    expect(await finalStatus(wallet, (await first).id)).toMatchObject({ status: 500 });
    expect(chain.sent.map((tx) => tx.to)).toEqual([BOB]);

    const second = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest({ calls: calls(CAROL, BOB, CAROL) })] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const result = await finalStatus(wallet, (await second).id);
    expect(result.status).toBe(600);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(['0x1', '0x0']);
    expect(chain.sent.map((tx) => tx.to)).toEqual([BOB, CAROL, BOB]);
  });

  it('asks separately for a call whose fee could only be estimated after the previous call', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    // CAROL's call reverts in simulation until BOB's call is mined (like approve → swap).
    rpc.handlers.eth_estimateGas = ([call]) => {
      if (call.to?.toLowerCase() === CAROL.toLowerCase() && chain.sent.length === 0) {
        throw new Error('execution reverted');
      }
      return '0x5208';
    };
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    const batchApproval = await nextApproval(wallet);
    expect(batchApproval.params.calls[1].maxFeeEther).toBeNull();
    expect(batchApproval.params.totals.deferred).toBe(1);
    await wallet.popup.handle('resolveApproval', { id: batchApproval.id, approved: true });
    const { id } = await pending;

    const step = await nextApproval(wallet);
    expect(step).toMatchObject({ type: 'transaction', params: { to: CAROL, batch: { index: 2, total: 2 } } });
    expect(chain.sent).toHaveLength(1);
    await wallet.popup.handle('resolveApproval', { id: step.id, approved: true });
    expect(await finalStatus(wallet, id)).toMatchObject({ status: 200 });
    expect(chain.sent.map((tx) => tx.to)).toEqual([BOB, CAROL]);
  });

  it('stops without signing further calls on reject, lock, network change or revoked connection', async () => {
    for (const interrupt of ['reject', 'lock', 'network', 'revoke']) {
      const { wallet, rpc } = await setupUnlockedWallet();
      await connect(wallet);
      const chain = simulateChain(rpc);
      rpc.handlers.eth_estimateGas = ([call]) => {
        if (call.to?.toLowerCase() === CAROL.toLowerCase() && chain.sent.length === 0) throw new Error('reverted');
        return '0x5208';
      };
      const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
      await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
      const { id } = await pending;
      const step = await nextApproval(wallet);
      if (interrupt === 'reject') {
        await wallet.popup.handle('resolveApproval', { id: step.id, approved: false });
      } else if (interrupt === 'lock') {
        await wallet.vault.lock();
      } else if (interrupt === 'network') {
        await wallet.popup.handle('selectNetwork', { chainId: '0x89' });
        await wallet.popup.handle('resolveApproval', { id: step.id, approved: true });
      } else {
        await wallet.permissions.revoke(ORIGIN);
        await wallet.popup.handle('resolveApproval', { id: step.id, approved: true }).catch(() => {});
      }
      if (interrupt === 'revoke') {
        // A disconnected site loses its batch status entirely [review L3].
        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(status(wallet, id)).rejects.toMatchObject({ code: 5730 });
      } else {
        if (interrupt === 'lock') {
          await waitFor(() => !wallet.batch.hasRunningBatch(ORIGIN));
          await wallet.vault.unlock(TEST_PASSWORD); // status is hidden while locked [review L3]
        }
        expect(await finalStatus(wallet, id)).toMatchObject({ status: 600 });
      }
      expect(chain.sent.map((tx) => tx.to)).toEqual([BOB]);
    }
  });

  it('a restarted worker never resumes an unfinished batch', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc, { mine: false });
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const { id } = await pending;
    await waitFor(() => chain.sent.length === 1);

    // Simulate a fresh worker reading the persisted bundle (the old run loop is abandoned).
    wallet.batch.cancelAll();
    const restarted = new BatchController({ network: wallet.network, transactions: wallet.transactions, approvals: wallet.approvals, permissions: wallet.permissions, vault: wallet.vault, pollMs: 5, keepAlive() {} });
    await restarted.restore();
    expect(await restarted.getCallsStatus(ORIGIN, [id])).toMatchObject({ status: 100, receipts: [] });

    const [tx] = chain.sent;
    chain.receipts.set(tx.hash, { transactionHash: tx.hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x12', gasUsed: '0x5208', status: '0x1', logs: [] });
    expect(await restarted.getCallsStatus(ORIGIN, [id])).toMatchObject({ status: 600, receipts: [{ status: '0x1' }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chain.sent).toHaveLength(1);
  });
});

describe('batch security review regressions', () => {
  it('[M1] concurrent sends from one account never share a nonce', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const sent = [];
    rpc.handlers.eth_sendRawTransaction = ([raw]) => {
      sent.push(Transaction.from(raw));
      return sent.at(-1).hash;
    }; // eth_getTransactionCount stays at 0x7: a lagging node
    const proposals = [];
    for (const to of [BOB, CAROL]) {
      const request = { from: ACCOUNT, to, value: 1n, data: '0x', gasLimit: undefined };
      proposals.push(await wallet.transactions.prepare(request, '0x1'));
    }
    // Both signed concurrently: the per-account lock serialises them and the nonce never repeats.
    await Promise.all(proposals.map((proposal) => wallet.transactions.signAndSend(proposal, { origin: ORIGIN })));
    expect(sent.map((tx) => tx.nonce).sort()).toEqual([7, 8]);
  });

  it('[M2] records the hash before broadcasting, and drops it only when the node refuses', async () => {
    const { wallet, rpc, chrome } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    const broadcast = rpc.handlers.eth_sendRawTransaction;
    let persistedAtBroadcast = null;
    rpc.handlers.eth_sendRawTransaction = (params) => {
      const hash = Transaction.from(params[0]).hash;
      persistedAtBroadcast = chrome.storage.session.dump().callBundles.some((record) => record.hashes.includes(hash));
      return broadcast(params);
    };
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest({ calls: calls(BOB) })] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    expect(await finalStatus(wallet, (await pending).id)).toMatchObject({ status: 200 });
    expect(persistedAtBroadcast).toBe(true);
    expect(chain.sent).toHaveLength(1);

    // Node refuses the broadcast with a JSON-RPC error: nothing is on chain, so the batch reports 400.
    delete rpc.handlers.eth_sendRawTransaction;
    const again = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest({ calls: calls(BOB) })] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    expect(await finalStatus(wallet, (await again).id)).toMatchObject({ status: 400, receipts: [] });
    expect(rpc.calls.filter((call) => call.method === 'eth_sendRawTransaction')).toHaveLength(2);
  });

  it('[M3] stores no receipts or logs, and ignores receipts for a different hash', async () => {
    const { wallet, rpc, chrome } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest({ calls: calls(BOB) })] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const { id } = await pending;
    expect(await finalStatus(wallet, id)).toMatchObject({ status: 200 });
    const stored = JSON.stringify(chrome.storage.session.dump().callBundles);
    expect(stored).not.toContain('logs');
    expect(stored).not.toContain('blockHash');

    // A lying RPC returns someone else's receipt: it is not accepted.
    const [tx] = chain.sent;
    chain.receipts.set(tx.hash, { ...chain.receipts.get(tx.hash), transactionHash: `0x${'99'.repeat(32)}` });
    expect(await status(wallet, id)).toMatchObject({ status: 100, receipts: [] });
  });

  it('[L1/L4] a second batch prompt from the same site is refused before any RPC work', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    simulateChain(rpc);
    const first = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    const approval = await nextApproval(wallet);
    const estimatesBefore = rpc.calls.filter((call) => call.method === 'eth_estimateGas').length;
    await expect(wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] })).rejects.toMatchObject({ code: -32002 });
    expect(rpc.calls.filter((call) => call.method === 'eth_estimateGas').length).toBe(estimatesBefore);
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: false });
    await expect(first).rejects.toMatchObject({ code: 4001 });
  });

  it('[L2] a pre-approved call whose fees went stale is confirmed again with fresh fees', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    let offset = 0;
    wallet.batch.now = () => Date.now() + offset;
    rpc.handlers.eth_getTransactionReceipt = ([hash]) => {
      offset = 4 * 60 * 1000; // the first call takes "4 minutes" to mine
      return chain.receipts.get(hash) ?? null;
    };
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    const batchApproval = await nextApproval(wallet);
    expect(batchApproval.params.totals.deferred).toBe(0);
    await wallet.popup.handle('resolveApproval', { id: batchApproval.id, approved: true });
    const { id } = await pending;
    const step = await nextApproval(wallet);
    expect(step).toMatchObject({ type: 'transaction', params: { to: CAROL, batch: { index: 2, total: 2 } } });
    await wallet.popup.handle('resolveApproval', { id: step.id, approved: true });
    expect(await finalStatus(wallet, id)).toMatchObject({ status: 200 });
  });

  it('[L3] status is hidden while locked', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    simulateChain(rpc);
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest({ calls: calls(BOB) })] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const { id } = await pending;
    await finalStatus(wallet, id);
    await wallet.vault.lock();
    await expect(status(wallet, id)).rejects.toMatchObject({ code: 4100 });
  });
});

describe('stop batch (popup)', () => {
  it('lists a running batch and stops it while it waits for a receipt; sent calls still count', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc, { mine: false });
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const { id } = await pending;
    await waitFor(() => chain.sent.length === 1);

    expect(await wallet.popup.handle('listRunningBatches')).toEqual([{ origin: ORIGIN, id, chainId: '0x1', total: 2, sent: 1, confirmed: 0 }]);
    expect(await wallet.popup.handle('stopBatch', { origin: OTHER, id })).toBe(false);
    expect(await wallet.popup.handle('stopBatch', { origin: ORIGIN, id })).toBe(true);
    await waitFor(async () => (await wallet.popup.handle('listRunningBatches')).length === 0);
    await waitFor(() => !wallet.batch.hasRunningBatch(ORIGIN));

    expect(await status(wallet, id)).toMatchObject({ status: 100 }); // first tx still unmined
    const [tx] = chain.sent;
    chain.receipts.set(tx.hash, { transactionHash: tx.hash, blockHash: `0x${'ef'.repeat(32)}`, blockNumber: '0x12', gasUsed: '0x5208', status: '0x1', logs: [] });
    expect(await status(wallet, id)).toMatchObject({ status: 600 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(chain.sent).toHaveLength(1);
  });

  it('rejects the pending step prompt of a stopped batch', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const chain = simulateChain(rpc);
    rpc.handlers.eth_estimateGas = ([call]) => {
      if (call.to?.toLowerCase() === CAROL.toLowerCase() && chain.sent.length === 0) throw new Error('reverted');
      return '0x5208';
    };
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_sendCalls', params: [sendCallsRequest()] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const { id } = await pending;
    const step = await nextApproval(wallet);
    expect(step.params.batch).toMatchObject({ id, index: 2 });
    await wallet.popup.handle('stopBatch', { origin: ORIGIN, id });
    expect(wallet.approvals.get(step.id)).toBeNull();
    expect(await finalStatus(wallet, id)).toMatchObject({ status: 600 });
    expect(chain.sent.map((tx) => tx.to)).toEqual([BOB]);
  });
});
