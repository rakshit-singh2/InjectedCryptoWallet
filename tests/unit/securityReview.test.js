// Regression tests for the findings of the 2026-11-07 independent security review.
import { describe, expect, it } from 'vitest';
import { TypedDataEncoder, verifyTypedData } from 'ethers';
import { VaultController, LEGACY_BACKUP_RETENTION_MS } from '../../src/background/controllers/VaultController.js';
import { jsonRpc } from '../../src/background/controllers/NetworkController.js';
import { ORIGIN, connect, nextApproval, setupUnlockedWallet, TEST_MNEMONIC, TEST_PASSWORD } from './helpers.js';

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = 'https://other.example';

describe('security review regressions', () => {
  it('[M1] a lock during session restore keeps the wallet locked', async () => {
    await setupUnlockedWallet();
    const restarted = new VaultController({ kdfIterations: 1000 });
    const restoring = restarted.isUnlocked(); // starts decrypting with the cached session key
    await restarted.lock(); // auto-lock alarm fires meanwhile
    await restoring;
    expect(restarted.memory).toBeNull();
    expect(await restarted.isUnlocked()).toBe(false);
    await expect(restarted.getSigner(ACCOUNT)).rejects.toThrow(/locked/);
  });

  it('[M2] polling by the approval window does not postpone auto-lock', async () => {
    const { wallet, chrome } = await setupUnlockedWallet();
    let resets = 0;
    chrome.alarms.create = () => {
      resets += 1;
    };
    for (const method of ['getState', 'listApprovals', 'releaseApprovalWindow', 'getPreferences', 'listPermissions']) {
      await wallet.popup.handle(method);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resets).toBe(0);
    await wallet.popup.handle('touch');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resets).toBe(1);
  });

  it('[L3] typed-data approvals show only signed fields and flag the rest', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    const types = { Permit: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] };
    const data = {
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], ...types },
      primaryType: 'Permit',
      domain: { name: 'Token', chainId: 1 },
      message: { spender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: '1000', note: 'Login only - no funds move' },
    };
    const pending = wallet.provider.handle(ORIGIN, { method: 'eth_signTypedData_v4', params: [ACCOUNT, JSON.stringify(data)] });
    const approval = await nextApproval(wallet);
    expect(approval.params.message).toEqual({ spender: data.message.spender, value: '1000' });
    expect(approval.params.strippedFields).toEqual(['note']);
    await wallet.popup.handle('resolveApproval', { id: approval.id, approved: true });
    const signature = await pending;
    // Same digest as the original (extra key is ignored by EIP-712), so the signature is still valid for it.
    expect(TypedDataEncoder.hash(data.domain, types, data.message)).toBe(TypedDataEncoder.hash(data.domain, types, approval.params.message));
    expect(verifyTypedData(data.domain, types, data.message, signature)).toBe(ACCOUNT);
  });

  it('[L4] the user can reject every queued request from one site at once', async () => {
    const { wallet } = await setupUnlockedWallet();
    const flood = [0, 1, 2].map(() => wallet.provider.handle(ORIGIN, { method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', symbol: 'X', decimals: 18 } } }));
    const legit = wallet.provider.handle(OTHER, { method: 'eth_requestAccounts' });
    await nextApproval(wallet);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await wallet.popup.handle('rejectApprovalsFromOrigin', { origin: ORIGIN })).toBe(3);
    for (const request of flood) await expect(request).rejects.toMatchObject({ code: 4001 });
    expect(wallet.approvals.list().map((approval) => approval.origin)).toEqual([OTHER]);
    wallet.approvals.rejectAll();
    await expect(legit).rejects.toMatchObject({ code: 4001 });
  });

  it('[L5] the legacy backup is deleted on seed reset and expires after 30 days', async () => {
    let now = Date.now();
    const { chrome, wallet } = await setupUnlockedWallet();
    await chrome.storage.local.set({ legacyBackup: { migratedAt: now, seedRecord: { ciphertext: 'x' } } });
    await wallet.vault.lock();
    await wallet.popup.handle('resetWithMnemonic', { mnemonic: TEST_MNEMONIC, password: 'New-Password-2' });
    expect(chrome.storage.local.dump().legacyBackup).toBeUndefined();

    await chrome.storage.local.set({ legacyBackup: { migratedAt: now, seedRecord: { ciphertext: 'x' } } });
    const vault = new VaultController({ kdfIterations: 1000, now: () => now });
    await vault.lock();
    await vault.unlock('New-Password-2');
    expect(chrome.storage.local.dump().legacyBackup).toBeDefined(); // still within the grace period
    now += LEGACY_BACKUP_RETENTION_MS + 1;
    await vault.lock();
    await vault.unlock('New-Password-2');
    expect(chrome.storage.local.dump().legacyBackup).toBeUndefined();
  });

  it('[L8] wallet_getPermissions reveals nothing while locked', async () => {
    const { wallet } = await setupUnlockedWallet();
    await connect(wallet);
    expect(await wallet.provider.handle(ORIGIN, { method: 'wallet_getPermissions' })).toHaveLength(1);
    await wallet.vault.lock();
    expect(await wallet.provider.handle(ORIGIN, { method: 'wallet_getPermissions' })).toEqual([]);
    await wallet.vault.unlock(TEST_PASSWORD);
  });

  it('[L9] RPC bodies are size-capped while streaming, not after', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const endless = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const streaming = async () => ({ status: 200, headers: new Headers(), body: endless });
    await expect(jsonRpc('https://rpc.example', 'eth_blockNumber', [], { fetchImpl: streaming })).rejects.toMatchObject({ code: -32005 });
    expect(pulled).toBeLessThan(12); // stopped just past the 8 MB cap instead of reading forever

    const declared = async () => ({ status: 200, headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }), body: endless });
    await expect(jsonRpc('https://rpc.example', 'eth_blockNumber', [], { fetchImpl: declared })).rejects.toMatchObject({ code: -32005 });
  });
});
