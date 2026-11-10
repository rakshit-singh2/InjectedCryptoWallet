// Thin wrappers around chrome.storage so controllers stay testable.
// - local:   durable, extension-only (encrypted vault, public metadata, permissions)
// - session: memory-only, cleared on browser restart (unlock key, pending approvals)

function area(name) {
  const storage = globalThis.chrome?.storage?.[name];
  if (!storage) {
    throw new Error(`chrome.storage.${name} is unavailable.`);
  }
  return storage;
}

export const StorageKeys = Object.freeze({
  vault: 'vault',
  accounts: 'accounts',
  selectedAddress: 'selectedAddress',
  networks: 'networks',
  selectedChainId: 'selectedChainId',
  permissions: 'approvedOrigins',
  unlockThrottle: 'unlockThrottle',
  legacyBackup: 'legacyBackup',
  preferences: 'preferences',
  // session
  sessionKey: 'sessionVaultKey',
  approvals: 'pendingApprovals',
  callBundles: 'callBundles',
});

export async function getLocal(key) {
  const result = await area('local').get(key);
  return result[key];
}

export async function getLocalMany(keys) {
  return area('local').get(keys);
}

export async function setLocal(values) {
  await area('local').set(values);
}

export async function removeLocal(keys) {
  await area('local').remove(keys);
}

export async function getSession(key) {
  const result = await area('session').get(key);
  return result[key];
}

export async function setSession(values) {
  await area('session').set(values);
}

export async function removeSession(keys) {
  await area('session').remove(keys);
}

/** Restricts chrome.storage.session to extension pages and the service worker. */
export async function restrictSessionAccess() {
  const session = globalThis.chrome?.storage?.session;
  if (session?.setAccessLevel) {
    await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
}
