import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { HDNodeWallet, Wallet } from 'ethers';
import { createTestWallet, TEST_MNEMONIC, TEST_PASSWORD } from './helpers.js';
import { resetAssetDbForTests, getTokens } from '../../src/shared/assetStore.js';
import { toBase64 } from '../../src/background/vaultCrypto.js';

// Replicates the v1 popup implementation's encryptSecret (PBKDF2-SHA256 310k + AES-GCM).
async function legacyEncrypt(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret));
  return { version: 1, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

const hd = (index) => HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);

/** Builds a database exactly as the v1 storage.jsx schema created it. */
async function seedLegacyDb({ imported, plaintextImported }) {
  const db = await openDB('cryptoWallet', 1, {
    upgrade(database) {
      const wallet = database.createObjectStore('walletData', { keyPath: 'address' });
      wallet.createIndex('name', 'name', { unique: false });
      wallet.createIndex('walletKey', 'walletKey', { unique: true });
      wallet.createIndex('pinned', 'pinned', { unique: true });
      wallet.createIndex('imported', 'imported', { unique: true });
      const chains = database.createObjectStore('chainData', { keyPath: 'hex' });
      chains.createIndex('name', 'name', { unique: true });
      database.createObjectStore('userData', { keyPath: 'userId' });
    },
  });
  const base = { connectedSites: [], transactions: [], tokens: [], Nfts: [] };
  await db.put('walletData', { ...base, address: hd(0).address, name: 'Account 1', walletKey: await legacyEncrypt(hd(0).privateKey, TEST_PASSWORD), tokens: [{ address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', name: 'T', symbol: 'T', decimals: '18', chain: '0x89' }] });
  await db.put('walletData', { ...base, address: hd(1).address, name: 'Account 2', walletKey: await legacyEncrypt(hd(1).privateKey, TEST_PASSWORD) });
  await db.put('walletData', { ...base, address: imported.address, name: 'Account 3', walletKey: await legacyEncrypt(imported.privateKey, TEST_PASSWORD) });
  await db.put('walletData', { ...base, address: plaintextImported.address, name: 'Account 4', walletKey: plaintextImported.privateKey });
  await db.put('chainData', { hex: '0x89', name: 'Polygon', ticker: 'MATIC', rpcUrl: 'https://polygon-mainnet.infura.io/v3/60f3b7566e31462483f911b78b7fc13e', blockExplorerUrl: 'https://amoy.polygonscan.com', userAdded: 0 });
  await db.put('chainData', { hex: '0x7a69', name: 'Kalichain', ticker: 'KALIS', rpcUrl: 'https://mainnet.kalichain.com', blockExplorerUrl: 'https://explorer.kalichain.com', userAdded: 0 });
  await db.put('chainData', { hex: '0x1234', name: 'Bad', ticker: 'BAD', rpcUrl: 'http://insecure.example', blockExplorerUrl: '', userAdded: 1 });
  await db.put('userData', { userId: 'KuchBhi', lastChain: '0x89', childCount: '2', password: '{"version":1}' });
  db.close();
}

describe('legacy v1 -> v2 migration', () => {
  let imported;
  let plaintextImported;
  let seedRecord;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    resetAssetDbForTests();
    imported = Wallet.createRandom();
    plaintextImported = Wallet.createRandom();
    await seedLegacyDb({ imported, plaintextImported });
    seedRecord = JSON.stringify(await legacyEncrypt(TEST_MNEMONIC, TEST_PASSWORD));
  });

  it('rejects a wrong password without changing anything', async () => {
    const { wallet, chrome } = createTestWallet();
    await expect(wallet.popup.handle('migrateLegacy', { password: 'Wrong-Pass-1', seedRecord })).rejects.toThrow(/Incorrect password/);
    expect(chrome.storage.local.dump().vault).toBeUndefined();
    const db = await openDB('cryptoWallet');
    expect((await db.getAll('walletData')).every((record) => 'walletKey' in record)).toBe(true);
    db.close();
  });

  it('moves every account into the vault, keeps assets and networks, and strips old keys', async () => {
    const { wallet, chrome } = createTestWallet();
    const result = await wallet.popup.handle('migrateLegacy', { password: TEST_PASSWORD, seedRecord });
    expect(result).toEqual({ alreadyMigrated: false, migratedAccounts: 4 });

    const accounts = await wallet.vault.getAccounts();
    expect(accounts).toEqual([
      { address: hd(0).address, name: 'Account 1', type: 'hd', index: 0 },
      { address: hd(1).address, name: 'Account 2', type: 'hd', index: 1 },
      { address: imported.address, name: 'Account 3', type: 'imported' },
      { address: plaintextImported.address, name: 'Account 4', type: 'imported' },
    ]);
    expect((await wallet.vault.getSigner(imported.address)).privateKey).toBe(imported.privateKey);
    expect((await wallet.vault.getSigner(plaintextImported.address)).privateKey).toBe(plaintextImported.privateKey);

    const networks = await wallet.network.getNetworks();
    expect(networks['0x89'].rpcUrl).toBe('https://polygon-bor-rpc.publicnode.com'); // built-in replaces the keyed Infura URL
    expect(networks['0x7a69']).toMatchObject({ name: 'Kalichain', builtIn: false });
    expect(networks['0x1234']).toBeUndefined(); // insecure legacy RPC dropped
    expect(await wallet.network.getSelectedChainId()).toBe('0x89');

    const local = JSON.stringify(chrome.storage.local.dump());
    expect(local).not.toContain(plaintextImported.privateKey.slice(2));
    expect(local).not.toContain(TEST_MNEMONIC);

    const db = await openDB('cryptoWallet');
    const records = await db.getAll('walletData');
    expect(records.some((record) => 'walletKey' in record)).toBe(false);
    expect(JSON.stringify(records)).not.toContain(plaintextImported.privateKey.slice(2));
    expect(Array.from(db.transaction('walletData').store.indexNames)).toEqual([]);
    expect((await db.get('userData', 'KuchBhi')).password).toBeUndefined();
    db.close();

    expect(await getTokens(hd(0).address, '0x89')).toHaveLength(1);

    // Idempotent: a second run is a no-op, but it retries stripping legacy keys left by an interrupted run [L6].
    const again = await openDB('cryptoWallet');
    await again.put('walletData', { ...records[0], walletKey: 'leftover' });
    again.close();
    expect(await wallet.popup.handle('migrateLegacy', { password: TEST_PASSWORD, seedRecord })).toMatchObject({ alreadyMigrated: true });
    const after = await openDB('cryptoWallet');
    expect((await after.getAll('walletData')).some((record) => 'walletKey' in record)).toBe(false);
    after.close();

    // New password == old password.
    await wallet.vault.lock();
    await wallet.vault.unlock(TEST_PASSWORD);
  });
});
