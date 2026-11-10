// Reads the pre-1.1 wallet layout that lived in the popup's localStorage. The background service
// worker cannot read localStorage, so the popup hands the (still encrypted) record over during the
// one-time upgrade and then removes the leftovers.

const LEGACY_VAULT_KEY = 'wallet-secure-vault';
const LEGACY_KEYS = [LEGACY_VAULT_KEY, 'wallet-password-hash', 'wallet-seed-hash'];

export function getLegacySeedRecord() {
  try {
    return globalThis.localStorage?.getItem(LEGACY_VAULT_KEY) || null;
  } catch {
    return null;
  }
}

/** Only call after the background confirms the vault was migrated (or already exists). */
export function clearLegacyLocalStorage() {
  try {
    for (const key of LEGACY_KEYS) {
      globalThis.localStorage?.removeItem(key);
    }
    globalThis.sessionStorage?.removeItem('pendingWalletSeed');
    globalThis.sessionStorage?.removeItem('pendingWalletAccount');
  } catch {
    // storage unavailable; nothing to clean up
  }
}
