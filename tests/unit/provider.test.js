import { describe, expect, it } from 'vitest';
import { Transaction, verifyMessage, verifyTypedData, Wallet } from 'ethers';
import { ORIGIN, connect, createTestWallet, nextApproval, setupUnlockedWallet, TEST_PASSWORD } from './helpers.js';
import { getTokens } from '../../src/shared/assetStore.js';

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = 'https://evil.example';

const typedData = (chainId = 1) => ({
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    Mail: [{ name: 'contents', type: 'string' }],
  },
  primaryType: 'Mail',
  domain: { name: 'Test', chainId },
  message: { contents: 'hello' },
});

describe('connection and permissions', () => {
  it('returns no accounts before approval and only the approved account afterwards', async () => {
    const { wallet } = await setupUnlockedWallet();
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_accounts' })).toEqual([]);
    expect(await connect(wallet)).toEqual([ACCOUNT]);
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_accounts' })).toEqual([ACCOUNT]);
    expect(await wallet.provider.handle(OTHER, { method: 'eth_accounts' })).toEqual([]);
  });

  it('rejects with 4001 when the user rejects, and 4001 when the approval window closes', async () => {
    const { wallet } = await setupUnlockedWallet();
    const first = wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: false });
    await expect(first).rejects.toMatchObject({ code: 4001 });

    const second = wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' });
    await nextApproval(wallet);
    wallet.approvals.handleWindowRemoved(77);
    await expect(second).rejects.toMatchObject({ code: 4001 });
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_accounts' })).toEqual([]);
  });

  it('returns -32002 for a duplicate pending connection request', async () => {
    const { wallet } = await setupUnlockedWallet();
    const first = wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' });
    await nextApproval(wallet);
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' })).rejects.toMatchObject({ code: -32002 });
    wallet.approvals.rejectAll();
    await expect(first).rejects.toMatchObject({ code: 4001 });
  });

  it('closing a released (empty) approval window cannot reject a request that arrived afterwards', async () => {
    const { wallet, chrome } = await setupUnlockedWallet();
    const first = wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' });
    const approval = await nextApproval(wallet);
    expect(await wallet.popup.handle('releaseApprovalWindow')).toBe(false); // still pending: keep window
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: false });
    await expect(first).rejects.toMatchObject({ code: 4001 });
    expect(await wallet.popup.handle('releaseApprovalWindow')).toBe(true);

    const second = wallet.provider.handle(OTHER, { method: 'eth_requestAccounts' });
    await nextApproval(wallet);
    expect(chrome.windows.created).toBe(2); // a fresh window, not the one being closed
    wallet.approvals.handleWindowRemoved(77); // the old window finishes closing
    expect(wallet.approvals.list()).toHaveLength(1);
    wallet.approvals.handleWindowRemoved(78); // user closes the new window
    await expect(second).rejects.toMatchObject({ code: 4001 });
  });

  it('refuses to grant accounts that do not belong to the wallet', async () => {
    const { wallet } = await setupUnlockedWallet();
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' });
    const approval = await nextApproval(wallet);
    await expect(
      wallet.popup.handle('resolveApproval', { id: approval.id, approved: true, data: { accounts: [Wallet.createRandom().address] } }),
    ).rejects.toThrow(/Select at least one/);
    wallet.approvals.rejectAll();
    await expect(pending).rejects.toMatchObject({ code: 4001 });
  });

  it('hides accounts while locked and rejects pending approvals on lock', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    const signing = wallet.provider.handle(ORIGIN, { method: 'personal_sign', params: ['0x68656c6c6f', ACCOUNT] });
    await nextApproval(wallet);
    await wallet.popup.handle('lock');
    await expect(signing).rejects.toMatchObject({ code: 4001 });
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_accounts' })).toEqual([]);
  });

  it('supports EIP-2255 get/revoke permissions', async () => {
    const { wallet, notifications } = await setupUnlockedWallet();
    await connect(wallet);
    const [permission] = await wallet.provider.handle(ORIGIN, { method: 'wallet_getPermissions' });
    expect(permission).toMatchObject({ invoker: ORIGIN, parentCapability: 'eth_accounts', caveats: [{ value: [ACCOUNT] }] });
    const before = notifications.length;
    await wallet.provider.handle(ORIGIN, { method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    expect(notifications.length).toBeGreaterThan(before);
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_accounts' })).toEqual([]);
  });

  it('fails with 4100 when no wallet exists', async () => {
    const { wallet } = createTestWallet();
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' })).rejects.toMatchObject({ code: 4100 });
  });
});

describe('method policy', () => {
  it('refuses eth_sign and unknown methods, forwards allow-listed reads', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_sign', params: [ACCOUNT, '0x00'] })).rejects.toMatchObject({ code: 4200 });
    await expect(wallet.provider.handle(ORIGIN, { method: 'admin_peers' })).rejects.toMatchObject({ code: 4200 });
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_blockNumber' })).toBe('0x10');
    expect(rpc.calls.at(-1).method).toBe('eth_blockNumber');
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_call', params: 'nope' })).rejects.toMatchObject({ code: -32602 });
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_chainId' })).toBe('0x1');
    expect(await wallet.provider.handle(ORIGIN, { method: 'net_version' })).toBe('1');
  });
});

describe('signing', () => {
  it('requires a connected account', async () => {
    const { wallet } = await setupUnlockedWallet();
    await expect(wallet.provider.handle(ORIGIN, { method: 'personal_sign', params: ['0x68656c6c6f', ACCOUNT] })).rejects.toMatchObject({ code: 4100 });
  });

  it('personal_sign produces a signature only after approval', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    const pending = wallet.provider.handle(ORIGIN, { method: 'personal_sign', params: ['0x68656c6c6f', ACCOUNT] });
    const approval = await nextApproval(wallet);
    expect(approval).toMatchObject({ origin: ORIGIN, type: 'personalSign', params: { preview: 'hello', isText: true } });
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    expect(verifyMessage('hello', await pending)).toBe(ACCOUNT);
  });

  it('eth_signTypedData_v4 checks the domain chain and signs valid data', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    await expect(
      wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(typedData(137))] }),
    ).rejects.toMatchObject({ code: -32602 });

    const data = typedData(1);
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(data)] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    const { EIP712Domain: _ignored, ...types } = data.types;
    expect(verifyTypedData(data.domain, types, data.message, await pending)).toBe(ACCOUNT);
  });
});

describe('eth_sendTransaction', () => {
  const tx = { from: ACCOUNT, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: '0xde0b6b3a7640000' };

  it('never broadcasts when rejected', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [tx] });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: false });
    await expect(pending).rejects.toMatchObject({ code: 4001 });
    expect(rpc.calls.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('signs exactly the reviewed EIP-1559 transaction for the selected chain', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [tx] });
    const approval = await nextApproval(wallet);
    expect(approval.params).toMatchObject({ chainId: '0x1', type: 2, gasLimit: '0x5208', display: { valueEther: '1.0' } });
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    const hash = await pending;

    const raw = rpc.calls.find((call) => call.method === 'eth_sendRawTransaction').params[0];
    const signed = Transaction.from(raw);
    expect(signed.hash).toBe(hash);
    expect(signed.from).toBe(ACCOUNT);
    expect(signed.to).toBe(tx.to);
    expect(signed.value).toBe(10n ** 18n);
    expect(signed.chainId).toBe(1n);
    expect(signed.nonce).toBe(7);
    expect(signed.maxFeePerGas).toBe(BigInt(approval.params.maxFeePerGas));
  });

  it('rejects mismatched chainId, foreign accounts and malformed fields before prompting', async () => {
    const { wallet, chrome } = await setupUnlockedWallet();
    await connect(wallet);
    const windowsBefore = chrome.windows.shown;
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [{ ...tx, chainId: '0x89' }] })).rejects.toMatchObject({ code: -32602 });
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [{ ...tx, from: Wallet.createRandom().address }] })).rejects.toMatchObject({ code: 4100 });
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [{ ...tx, value: '1000' }] })).rejects.toMatchObject({ code: -32602 });
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [{ ...tx, data: '0xzz' }] })).rejects.toMatchObject({ code: -32602 });
    expect(chrome.windows.shown).toBe(windowsBefore);
  });

  it('refuses to sign if the network changed during review', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    await connect(wallet);
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [tx] });
    const approval = await nextApproval(wallet);
    await wallet.popup.handle('selectNetwork', { chainId: '0x89' });
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    await expect(pending).rejects.toMatchObject({ code: 4901 });
    expect(rpc.calls.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('decodes unlimited ERC-20 approvals for the approval screen', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    const spender = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
    const data = `0x095ea7b3${spender.slice(2).padStart(64, '0')}${'f'.repeat(64)}`;
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_sendTransaction', params: [{ from: ACCOUNT, to: tx.to, data }] });
    const approval = await nextApproval(wallet);
    expect(approval.params.display.calldata).toMatchObject({ kind: 'erc20-approve', unlimited: true });
    expect(approval.params.gasLimit).toBe(`0x${((21000n * 120n) / 100n).toString(16)}`);
    wallet.approvals.rejectAll();
    await expect(pending).rejects.toMatchObject({ code: 4001 });
  });
});

describe('wallet-initiated send', () => {
  it('prepares a reviewable proposal and signs it once', async () => {
    const { wallet, rpc } = await setupUnlockedWallet();
    const proposal = await wallet.popup.handle('prepareSend', { to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', amount: '0.5' });
    expect(proposal.display.valueEther).toBe('0.5');
    await wallet.popup.handle('confirmSend', { id: proposal.id });
    await expect(wallet.popup.handle('confirmSend', { id: proposal.id })).rejects.toThrow(/expired/);
    expect(rpc.calls.filter((call) => call.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });
});

describe('network methods', () => {
  it('switches only to known chains, after approval', async () => {
    const { wallet, notifications } = await setupUnlockedWallet();
    await expect(wallet.provider.handle(ORIGIN, { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x999' }] })).rejects.toMatchObject({ code: 4902 });
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] });
    const before = notifications.length;
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    expect(await pending).toBeNull();
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_chainId' })).toBe('0x89');
    expect(notifications.length).toBeGreaterThan(before);
  });

  it('wallet_addEthereumChain validates the RPC before prompting', async () => {
    const { wallet } = await setupUnlockedWallet({ rpc: { chainId: '0x1' } });
    const definition = { chainId: '0x539', chainName: 'Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['http://localhost:8545'] };
    await expect(wallet.provider.handle(ORIGIN, { method: 'wallet_addEthereumChain', params: [definition] })).rejects.toMatchObject({ code: -32602 });
    await expect(
      wallet.provider.handle(ORIGIN, { method: 'wallet_addEthereumChain', params: [{ ...definition, rpcUrls: ['http://evil.example'] }] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('wallet_watchAsset stores the token after approval', async () => {
    const { wallet } = await setupUnlockedWallet();
    const token = { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', symbol: 'TST', decimals: 18 };
    const pending = wallet.provider.handle(ORIGIN, { method: 'wallet_watchAsset', params: { type: 'ERC20', options: token } });
    await wallet.popup.handle('resolveApproval', { id: (await nextApproval(wallet)).id, approved: true });
    expect(await pending).toBe(true);
    expect(await getTokens(ACCOUNT, '0x1')).toEqual([expect.objectContaining({ address: token.address, symbol: 'TST', decimals: '18' })]);
  });
});

describe('unlock via approval window', () => {
  it('a previously connected site prompts for unlock and then receives its accounts', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    await wallet.vault.lock();
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_requestAccounts' });
    const approval = await nextApproval(wallet);
    expect(approval.type).toBe('unlock');
    await expect(wallet.popup.handle('resolveApproval', { id: approval.id, approved: true })).rejects.toThrow(/locked/);
    await wallet.popup.handle('unlock', { password: TEST_PASSWORD });
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    expect(await pending).toEqual([ACCOUNT]);
  });
});

describe('rate limiting', () => {
  it('throttles a flooding origin without affecting other origins', async () => {
    const { RateLimiter } = await import('../../src/background/rateLimit.js');
    let now = 0;
    const context = createTestWallet();
    const { createWallet } = await import('../../src/background/wallet.js');
    const wallet = createWallet({
      kdfIterations: 1000,
      fetchImpl: context.rpc.fetchImpl,
      windows: context.chrome.windows,
      runtime: context.chrome.runtime,
      rateLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 1, now: () => now }),
    });
    for (let i = 0; i < 5; i += 1) {
      await wallet.provider.handle(ORIGIN, { method: 'eth_chainId' });
    }
    await expect(wallet.provider.handle(ORIGIN, { method: 'eth_chainId' })).rejects.toMatchObject({ code: -32005 });
    expect(await wallet.provider.handle(OTHER, { method: 'eth_chainId' })).toBe('0x1');
    now += 1000;
    expect(await wallet.provider.handle(ORIGIN, { method: 'eth_chainId' })).toBe('0x1');
  });
});
