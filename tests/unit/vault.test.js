import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { VaultController } from '../../src/background/controllers/VaultController.js';
import { createTestWallet, setupUnlockedWallet, TEST_MNEMONIC, TEST_PASSWORD } from './helpers.js';

const FIRST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // m/44'/60'/0'/0/0 of TEST_MNEMONIC
const SECOND_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('VaultController', () => {
  it('creates an encrypted vault and never stores the mnemonic in plaintext', async () => {
    const { chrome, wallet } = await setupUnlockedWallet();
    const local = JSON.stringify(chrome.storage.local.dump());
    const session = JSON.stringify(chrome.storage.session.dump());
    expect(local).not.toContain('junk');
    expect(session).not.toContain('junk');
    expect(local).not.toContain(TEST_PASSWORD);
    expect(session).not.toContain(TEST_PASSWORD);
    expect(await wallet.vault.getAccounts()).toEqual([{ address: FIRST_ADDRESS, name: 'Account 1', type: 'hd', index: 0 }]);
    expect(await wallet.vault.isUnlocked()).toBe(true);
  });

  it('refuses to overwrite an existing vault', async () => {
    const { wallet } = await setupUnlockedWallet();
    await expect(wallet.popup.handle('createVault', { mnemonic: TEST_MNEMONIC, password: TEST_PASSWORD })).rejects.toThrow(/already exists/);
  });

  it('rejects invalid mnemonics and short passwords', async () => {
    const { wallet } = createTestWallet();
    await expect(wallet.vault.createVault({ mnemonic: 'not a real phrase', password: TEST_PASSWORD })).rejects.toThrow(/BIP-39/);
    await expect(wallet.vault.createVault({ mnemonic: TEST_MNEMONIC, password: 'short' })).rejects.toThrow(/at least 8/);
  });

  it('restores the unlocked session after a service-worker restart, and fails closed after lock', async () => {
    const { wallet } = await setupUnlockedWallet();
    const restarted = new VaultController({ kdfIterations: 1000 });
    expect(await restarted.isUnlocked()).toBe(true);
    expect((await restarted.getSigner(FIRST_ADDRESS)).address).toBe(FIRST_ADDRESS);

    await wallet.vault.lock();
    const afterLock = new VaultController({ kdfIterations: 1000 });
    expect(await afterLock.isUnlocked()).toBe(false);
    await expect(afterLock.getSigner(FIRST_ADDRESS)).rejects.toThrow(/locked/);
  });

  it('throttles repeated wrong passwords', async () => {
    let now = 1_000_000;
    const { wallet } = await setupUnlockedWallet();
    await wallet.vault.lock();
    const vault = new VaultController({ kdfIterations: 1000, now: () => now });
    for (let i = 0; i < 5; i += 1) {
      await expect(vault.unlock('wrong-password')).rejects.toThrow(/Incorrect password/);
    }
    await expect(vault.unlock(TEST_PASSWORD)).rejects.toThrow(/Too many incorrect attempts/);
    now += 31_000;
    await vault.unlock(TEST_PASSWORD);
    expect(await vault.isUnlocked()).toBe(true);
  });

  it('detects tampered ciphertext', async () => {
    const { chrome, wallet } = await setupUnlockedWallet();
    await wallet.vault.lock();
    const vault = chrome.storage.local.dump().vault;
    const bytes = Buffer.from(vault.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    await chrome.storage.local.set({ vault: { ...vault, ciphertext: bytes.toString('base64') } });
    await expect(wallet.vault.unlock(TEST_PASSWORD)).rejects.toThrow(/Incorrect password/);
  });

  it('derives sequential HD accounts and imports private keys', async () => {
    const { wallet } = await setupUnlockedWallet();
    const second = await wallet.popup.handle('addAccount');
    expect(second.address).toBe(SECOND_ADDRESS);
    const key = Wallet.createRandom().privateKey;
    const imported = await wallet.popup.handle('importAccount', { privateKey: key.slice(2) });
    expect(imported.type).toBe('imported');
    await expect(wallet.popup.handle('importAccount', { privateKey: key })).rejects.toThrow(/already/);
    // survives lock/unlock (imported key persisted inside the encrypted vault)
    await wallet.vault.lock();
    await wallet.vault.unlock(TEST_PASSWORD);
    expect((await wallet.vault.getSigner(imported.address)).privateKey).toBe(key);
  });

  it('requires the password again to export a private key', async () => {
    const { wallet } = await setupUnlockedWallet();
    await expect(wallet.popup.handle('exportPrivateKey', { address: FIRST_ADDRESS, password: 'nope-nope' })).rejects.toThrow(/Incorrect/);
    const key = await wallet.popup.handle('exportPrivateKey', { address: FIRST_ADDRESS, password: TEST_PASSWORD });
    expect(new Wallet(key).address).toBe(FIRST_ADDRESS);
  });

  it('resets the password from the recovery phrase and requires confirmation to drop imported keys', async () => {
    const { wallet } = await setupUnlockedWallet();
    await wallet.popup.handle('addAccount');
    const imported = await wallet.popup.handle('importAccount', { privateKey: Wallet.createRandom().privateKey });
    await wallet.vault.lock();

    const wrongPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await expect(wallet.popup.handle('resetWithMnemonic', { mnemonic: wrongPhrase, password: 'New-Password-2' })).rejects.toThrow(/does not match/);

    const blocked = wallet.popup.handle('resetWithMnemonic', { mnemonic: TEST_MNEMONIC, password: 'New-Password-2' });
    await expect(blocked).rejects.toMatchObject({ data: { importedAccounts: [imported.address] } });

    const result = await wallet.popup.handle('resetWithMnemonic', { mnemonic: TEST_MNEMONIC, password: 'New-Password-2', confirmDropImported: true });
    expect(result.removedAccounts).toEqual([imported.address]);
    expect((await wallet.vault.getAccounts()).map((a) => a.address)).toEqual([FIRST_ADDRESS, SECOND_ADDRESS]);
    await wallet.vault.lock();
    await expect(wallet.vault.unlock(TEST_PASSWORD)).rejects.toThrow();
    await wallet.vault.unlock('New-Password-2');
  });

  it('rejects account metadata that does not match the vault secrets', async () => {
    const { chrome, wallet } = await setupUnlockedWallet();
    await wallet.vault.lock();
    await chrome.storage.local.set({ accounts: [{ address: SECOND_ADDRESS, name: 'evil', type: 'hd', index: 0 }] });
    await expect(wallet.vault.unlock(TEST_PASSWORD)).rejects.toThrow(/inconsistent/);
    expect(await wallet.vault.isUnlocked()).toBe(false);
  });
});

describe('auto-lock preferences', () => {
  it('only accepts the offered durations and reschedules the alarm', async () => {
    const { wallet, chrome } = await setupUnlockedWallet();
    const scheduled = [];
    chrome.alarms.create = (name, info) => scheduled.push(info.delayInMinutes);
    expect(await wallet.popup.handle('getPreferences')).toMatchObject({ autoLockMinutes: 15 });
    await expect(wallet.popup.handle('setPreferences', { autoLockMinutes: 0 })).rejects.toThrow(/Auto-lock must be/);
    await expect(wallet.popup.handle('setPreferences', { autoLockMinutes: 99999 })).rejects.toThrow(/Auto-lock must be/);
    expect(await wallet.popup.handle('setPreferences', { autoLockMinutes: 5 })).toMatchObject({ autoLockMinutes: 5 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduled.at(-1)).toBe(5);
  });
});
