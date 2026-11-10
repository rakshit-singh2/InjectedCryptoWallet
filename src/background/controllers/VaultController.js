import { HDNodeWallet, Mnemonic, Wallet } from 'ethers';
import {
  createVaultKey,
  DEFAULT_KDF_ITERATIONS,
  encryptWithKey,
  exportKey,
  importKey,
  isVaultRecord,
  decryptWithKey,
  unlockVaultRecord,
} from '../vaultCrypto.js';
import { StorageKeys, getLocal, getLocalMany, setLocal, removeLocal, getSession, setSession, removeSession } from '../store.js';
import { WalletError, ErrorCodes, invalidParams } from '../errors.js';
import { normalizeText, sameAddress } from '../validation.js';

const HD_PATH = (index) => `m/44'/60'/0'/0/${index}`;
const MIN_PASSWORD_LENGTH = 8;
const MAX_ACCOUNTS = 100;
export const AUTO_LOCK_ALARM = 'wallet-auto-lock';
const DEFAULT_AUTO_LOCK_MINUTES = 15;
export const AUTO_LOCK_CHOICES = Object.freeze([1, 5, 15, 30, 60, 240]);
const FREE_UNLOCK_ATTEMPTS = 5;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;
export const LEGACY_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function normalizeMnemonic(phrase) {
  if (typeof phrase !== 'string') {
    throw invalidParams('A recovery phrase is required.');
  }
  const normalized = phrase.trim().toLowerCase().split(/\s+/).join(' ');
  if (!Mnemonic.isValidMnemonic(normalized)) {
    throw invalidParams('The recovery phrase is not a valid BIP-39 mnemonic.');
  }
  return normalized;
}

function normalizePrivateKey(value) {
  if (typeof value !== 'string') {
    throw invalidParams('A private key is required.');
  }
  const trimmed = value.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw invalidParams('Private keys must be 32 bytes of hexadecimal.');
  }
  try {
    return new Wallet(withPrefix).privateKey;
  } catch {
    throw invalidParams('The private key is not valid for secp256k1.');
  }
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 1024) {
    throw invalidParams(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

function deriveHd(mnemonic, index) {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, HD_PATH(index));
}

/**
 * Owns the encrypted vault and every private key. Secrets only ever exist decrypted in this
 * service worker's memory; the AES key (not the password) is cached in chrome.storage.session so
 * the wallet survives service-worker suspension until the browser restarts or the wallet locks.
 */
export class VaultController {
  constructor({ kdfIterations = DEFAULT_KDF_ITERATIONS, now = () => Date.now(), alarms = globalThis.chrome?.alarms } = {}) {
    this.kdfIterations = kdfIterations;
    this.now = now;
    this.alarms = alarms;
    this.memory = null; // { key, kdf, secrets: { mnemonic, importedKeys } }
    this.lockListeners = new Set();
    this.restorePromise = null;
    // Incremented by lock(); an in-flight session restore that started before a lock must not
    // re-install the secrets it decrypted afterwards.
    this.lockGeneration = 0;
  }

  onLock(listener) {
    this.lockListeners.add(listener);
  }

  // ------------------------------------------------------------------ state

  async isInitialized() {
    return isVaultRecord(await getLocal(StorageKeys.vault));
  }

  async isUnlocked() {
    await this.restoreSession();
    return this.memory !== null;
  }

  async getAccounts() {
    const accounts = await getLocal(StorageKeys.accounts);
    return Array.isArray(accounts) ? accounts : [];
  }

  async getSelectedAddress() {
    const { [StorageKeys.selectedAddress]: selected, [StorageKeys.accounts]: accounts = [] } =
      await getLocalMany([StorageKeys.selectedAddress, StorageKeys.accounts]);
    const match = accounts.find((account) => sameAddress(account.address, selected));
    return match ? match.address : accounts[0]?.address ?? null;
  }

  async findAccount(address) {
    return (await this.getAccounts()).find((account) => sameAddress(account.address, address)) || null;
  }

  // ------------------------------------------------------------------ lifecycle

  async createVault({ mnemonic, password }) {
    if (await this.isInitialized()) {
      throw new WalletError(ErrorCodes.invalidRequest, 'A wallet already exists. Unlock it or reset it with its recovery phrase.');
    }
    validateNewPassword(password);
    const phrase = normalizeMnemonic(mnemonic);
    const first = deriveHd(phrase, 0);
    await this.writeNewVault({
      password,
      secrets: { mnemonic: phrase, importedKeys: {} },
      accounts: [{ address: first.address, name: 'Account 1', type: 'hd', index: 0 }],
      selectedAddress: first.address,
    });
  }

  /** Used by onboarding, legacy migration and seed reset. Replaces vault + account metadata atomically. */
  async writeNewVault({ password, secrets, accounts, selectedAddress, extra = {} }) {
    validateNewPassword(password);
    const { key, kdf } = await createVaultKey(password, this.kdfIterations);
    const record = await encryptWithKey(key, kdf, secrets);
    await setLocal({
      [StorageKeys.vault]: record,
      [StorageKeys.accounts]: accounts,
      [StorageKeys.selectedAddress]: selectedAddress,
      [StorageKeys.unlockThrottle]: { failures: 0, lockedUntil: 0 },
      ...extra,
    });
    await this.startSession(key, kdf, secrets);
  }

  async unlock(password) {
    const record = await getLocal(StorageKeys.vault);
    if (!isVaultRecord(record)) {
      throw new WalletError(ErrorCodes.invalidRequest, 'No wallet has been created yet.');
    }
    await this.assertNotThrottled();
    let result;
    try {
      result = await unlockVaultRecord(String(password ?? ''), record);
    } catch {
      await this.recordFailedUnlock();
      throw new WalletError(ErrorCodes.unauthorized, 'Incorrect password.');
    }
    await setLocal({ [StorageKeys.unlockThrottle]: { failures: 0, lockedUntil: 0 } });
    await this.verifyAccountsMatchSecrets(result.secrets);
    await this.startSession(result.key, record.kdf, result.secrets);
    await this.expireLegacyBackup();
  }

  /**
   * The v1 migration keeps the old records (encrypted under the old password) for a grace period
   * in case something went wrong. Once the new vault has proven usable for 30 days, drop them.
   */
  async expireLegacyBackup() {
    const backup = await getLocal(StorageKeys.legacyBackup);
    if (backup && this.now() - (Number(backup.migratedAt) || 0) > LEGACY_BACKUP_RETENTION_MS) {
      await removeLocal([StorageKeys.legacyBackup]);
    }
  }

  async startSession(key, kdf, secrets) {
    this.memory = { key, kdf, secrets: { mnemonic: secrets.mnemonic, importedKeys: { ...(secrets.importedKeys || {}) } } };
    await setSession({ [StorageKeys.sessionKey]: await exportKey(key) });
    this.touch();
  }

  /** Re-hydrates secrets after the service worker was suspended. Fails closed on any error. */
  async restoreSession() {
    if (this.memory) {
      return;
    }
    if (!this.restorePromise) {
      const generation = this.lockGeneration;
      this.restorePromise = (async () => {
        try {
          const rawKey = await getSession(StorageKeys.sessionKey);
          const record = await getLocal(StorageKeys.vault);
          if (!rawKey || !isVaultRecord(record)) {
            return;
          }
          const key = await importKey(rawKey);
          const secrets = await decryptWithKey(key, record);
          if (generation === this.lockGeneration && this.memory === null) {
            this.memory = { key, kdf: record.kdf, secrets };
          }
        } catch {
          if (generation === this.lockGeneration) {
            this.memory = null;
            await removeSession([StorageKeys.sessionKey]);
          }
        } finally {
          this.restorePromise = null;
        }
      })();
    }
    await this.restorePromise;
  }

  async lock() {
    this.lockGeneration += 1;
    const wasUnlocked = this.memory !== null || Boolean(await getSession(StorageKeys.sessionKey));
    this.memory = null;
    await removeSession([StorageKeys.sessionKey]);
    this.alarms?.clear?.(AUTO_LOCK_ALARM);
    if (wasUnlocked) {
      for (const listener of this.lockListeners) {
        await listener();
      }
    }
  }

  async getPreferences() {
    const prefs = (await getLocal(StorageKeys.preferences)) || {};
    const minutes = AUTO_LOCK_CHOICES.includes(prefs.autoLockMinutes) ? prefs.autoLockMinutes : DEFAULT_AUTO_LOCK_MINUTES;
    return { autoLockMinutes: minutes, autoLockChoices: [...AUTO_LOCK_CHOICES] };
  }

  async setPreferences({ autoLockMinutes }) {
    if (!AUTO_LOCK_CHOICES.includes(autoLockMinutes)) {
      throw invalidParams(`Auto-lock must be one of ${AUTO_LOCK_CHOICES.join(', ')} minutes.`);
    }
    const prefs = (await getLocal(StorageKeys.preferences)) || {};
    await setLocal({ [StorageKeys.preferences]: { ...prefs, autoLockMinutes } });
    this.touch();
    return this.getPreferences();
  }

  /** Resets the auto-lock timer. Called on any user activity in extension UI. */
  touch() {
    if (!this.memory || !this.alarms?.create) {
      return;
    }
    getLocal(StorageKeys.preferences)
      .then((prefs) => {
        const minutes = AUTO_LOCK_CHOICES.includes(prefs?.autoLockMinutes) ? prefs.autoLockMinutes : DEFAULT_AUTO_LOCK_MINUTES;
        this.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
      })
      .catch(() => {});
  }

  async assertNotThrottled() {
    const throttle = (await getLocal(StorageKeys.unlockThrottle)) || { failures: 0, lockedUntil: 0 };
    const remaining = (throttle.lockedUntil || 0) - this.now();
    if (remaining > 0) {
      throw new WalletError(
        ErrorCodes.limitExceeded,
        `Too many incorrect attempts. Try again in ${Math.ceil(remaining / 1000)} seconds.`,
      );
    }
  }

  async recordFailedUnlock() {
    const throttle = (await getLocal(StorageKeys.unlockThrottle)) || { failures: 0, lockedUntil: 0 };
    const failures = (throttle.failures || 0) + 1;
    const lockedUntil =
      failures >= FREE_UNLOCK_ATTEMPTS
        ? this.now() + Math.min(30_000 * 2 ** (failures - FREE_UNLOCK_ATTEMPTS), MAX_LOCKOUT_MS)
        : 0;
    await setLocal({ [StorageKeys.unlockThrottle]: { failures, lockedUntil } });
  }

  async verifyPassword(password) {
    const record = await getLocal(StorageKeys.vault);
    await this.assertNotThrottled();
    try {
      await unlockVaultRecord(String(password ?? ''), record);
    } catch {
      await this.recordFailedUnlock();
      throw new WalletError(ErrorCodes.unauthorized, 'Incorrect password.');
    }
    await setLocal({ [StorageKeys.unlockThrottle]: { failures: 0, lockedUntil: 0 } });
  }

  /** Account metadata is public; make sure every listed account is backed by the decrypted secrets. */
  async verifyAccountsMatchSecrets(secrets) {
    for (const account of await this.getAccounts()) {
      const importedKey = secrets.importedKeys?.[account.address.toLowerCase()];
      const derived =
        account.type === 'hd'
          ? deriveHd(secrets.mnemonic, account.index).address
          : importedKey && new Wallet(importedKey).address;
      if (!derived || !sameAddress(derived, account.address)) {
        throw new WalletError(ErrorCodes.internal, 'Wallet data is inconsistent. Restore from your recovery phrase.');
      }
    }
  }

  // ------------------------------------------------------------------ accounts

  requireUnlocked() {
    if (!this.memory) {
      throw new WalletError(ErrorCodes.unauthorized, 'The wallet is locked.');
    }
    return this.memory;
  }

  async persistSecrets() {
    const { key, kdf, secrets } = this.requireUnlocked();
    await setLocal({ [StorageKeys.vault]: await encryptWithKey(key, kdf, secrets) });
  }

  async addHdAccount(name) {
    await this.restoreSession();
    const { secrets } = this.requireUnlocked();
    const accounts = await this.getAccounts();
    if (accounts.length >= MAX_ACCOUNTS) {
      throw invalidParams('Account limit reached.');
    }
    const nextIndex = accounts.filter((a) => a.type === 'hd').reduce((max, a) => Math.max(max, a.index + 1), 0);
    const wallet = deriveHd(secrets.mnemonic, nextIndex);
    const account = {
      address: wallet.address,
      name: name ? normalizeText(name, 'Account name', { max: 32 }) : `Account ${accounts.length + 1}`,
      type: 'hd',
      index: nextIndex,
    };
    await setLocal({ [StorageKeys.accounts]: [...accounts, account], [StorageKeys.selectedAddress]: account.address });
    return account;
  }

  async importAccount(privateKey, name) {
    await this.restoreSession();
    const memory = this.requireUnlocked();
    const key = normalizePrivateKey(privateKey);
    const wallet = new Wallet(key);
    const accounts = await this.getAccounts();
    if (accounts.some((account) => sameAddress(account.address, wallet.address))) {
      throw invalidParams('This account is already in the wallet.');
    }
    if (accounts.length >= MAX_ACCOUNTS) {
      throw invalidParams('Account limit reached.');
    }
    memory.secrets.importedKeys[wallet.address.toLowerCase()] = key;
    try {
      await this.persistSecrets();
    } catch (error) {
      delete memory.secrets.importedKeys[wallet.address.toLowerCase()];
      throw error;
    }
    const account = {
      address: wallet.address,
      name: name ? normalizeText(name, 'Account name', { max: 32 }) : `Account ${accounts.length + 1}`,
      type: 'imported',
    };
    await setLocal({ [StorageKeys.accounts]: [...accounts, account], [StorageKeys.selectedAddress]: account.address });
    return account;
  }

  async renameAccount(address, name) {
    const accounts = await this.getAccounts();
    const target = accounts.find((account) => sameAddress(account.address, address));
    if (!target) {
      throw invalidParams('Unknown account.');
    }
    target.name = normalizeText(name, 'Account name', { max: 32 });
    await setLocal({ [StorageKeys.accounts]: accounts });
  }

  async selectAccount(address) {
    const account = await this.findAccount(address);
    if (!account) {
      throw invalidParams('Unknown account.');
    }
    await setLocal({ [StorageKeys.selectedAddress]: account.address });
    return account.address;
  }

  /** Re-authenticates with the password before revealing a key, as an extra guard against walk-up access. */
  async exportPrivateKey(address, password) {
    await this.restoreSession();
    this.requireUnlocked();
    await this.verifyPassword(password);
    return (await this.getSigner(address)).privateKey;
  }

  /** Internal only: never return this object (or its key) across a message boundary. */
  async getSigner(address) {
    await this.restoreSession();
    const { secrets } = this.requireUnlocked();
    const account = await this.findAccount(address);
    if (!account) {
      throw new WalletError(ErrorCodes.unauthorized, 'Unknown account.');
    }
    const wallet =
      account.type === 'hd'
        ? deriveHd(secrets.mnemonic, account.index)
        : new Wallet(secrets.importedKeys[account.address.toLowerCase()]);
    if (!sameAddress(wallet.address, account.address)) {
      throw new WalletError(ErrorCodes.internal, 'Account key mismatch.');
    }
    return wallet;
  }

  /**
   * Forgotten-password recovery. The phrase must reproduce the wallet's first HD account.
   * Imported keys were encrypted with the forgotten password and cannot be recovered, so the
   * caller must explicitly confirm dropping them.
   */
  async resetWithMnemonic({ mnemonic, password, confirmDropImported = false }) {
    const phrase = normalizeMnemonic(mnemonic);
    validateNewPassword(password);
    const accounts = await this.getAccounts();
    const hdAccounts = accounts.filter((account) => account.type === 'hd');
    const imported = accounts.filter((account) => account.type === 'imported');
    if (!hdAccounts.length) {
      throw invalidParams('This wallet has no recovery-phrase accounts.');
    }
    for (const account of hdAccounts) {
      if (!sameAddress(deriveHd(phrase, account.index).address, account.address)) {
        throw invalidParams('This recovery phrase does not match the wallet.');
      }
    }
    if (imported.length && !confirmDropImported) {
      throw new WalletError(
        ErrorCodes.invalidRequest,
        'Imported accounts cannot be recovered without the old password.',
        { importedAccounts: imported.map((account) => account.address) },
      );
    }
    const selected = await this.getSelectedAddress();
    await this.lock();
    // A reset often follows a leaked password: the legacy backup is encrypted under an old password
    // and would still expose the phrase and the "unrecoverable" imported keys, so delete it.
    await removeLocal([StorageKeys.legacyBackup]);
    await this.writeNewVault({
      password,
      secrets: { mnemonic: phrase, importedKeys: {} },
      accounts: hdAccounts,
      selectedAddress: hdAccounts.some((a) => sameAddress(a.address, selected)) ? selected : hdAccounts[0].address,
    });
    return { removedAccounts: imported.map((account) => account.address) };
  }
}
