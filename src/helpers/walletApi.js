// Popup-side client for the background wallet. The popup holds no keys or passwords beyond the
// lifetime of a single form submission; every sensitive operation happens in the service worker.

export class WalletApiError extends Error {
  constructor({ code, message, data }) {
    super(message || 'Wallet request failed.');
    this.code = code;
    this.data = data;
  }
}

export function isExtensionContext() {
  return Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.runtime?.sendMessage);
}

function call(method, params) {
  if (!isExtensionContext()) {
    return Promise.reject(new WalletApiError({ code: 4900, message: 'Open this page as the installed wallet extension.' }));
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: 'wallet-ui', method, params }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new WalletApiError({ code: 4900, message: chrome.runtime.lastError.message }));
      } else if (!response) {
        reject(new WalletApiError({ code: -32603, message: 'No response from the wallet.' }));
      } else if (response.error) {
        reject(new WalletApiError(response.error));
      } else {
        resolve(response.result);
      }
    });
  });
}

export const walletApi = {
  getState: () => call('getState'),
  createVault: (mnemonic, password) => call('createVault', { mnemonic, password }),
  unlock: (password) => call('unlock', { password }),
  lock: () => call('lock'),
  migrateLegacy: (password, seedRecord) => call('migrateLegacy', { password, seedRecord }),
  resetWithMnemonic: (mnemonic, password, confirmDropImported) =>
    call('resetWithMnemonic', { mnemonic, password, confirmDropImported }),
  addAccount: (name) => call('addAccount', { name }),
  importAccount: (privateKey, name) => call('importAccount', { privateKey, name }),
  renameAccount: (address, name) => call('renameAccount', { address, name }),
  selectAccount: (address) => call('selectAccount', { address }),
  exportPrivateKey: (address, password) => call('exportPrivateKey', { address, password }),
  selectNetwork: (chainId) => call('selectNetwork', { chainId }),
  addNetwork: (definition) => call('addNetwork', definition),
  editNetwork: (chainId, changes) => call('editNetwork', { chainId, ...changes }),
  removeNetwork: (chainId) => call('removeNetwork', { chainId }),
  listPermissions: () => call('listPermissions'),
  revokePermission: (origin) => call('revokePermission', { origin }),
  listApprovals: () => call('listApprovals'),
  releaseApprovalWindow: () => call('releaseApprovalWindow'),
  rejectApprovalsFromOrigin: (origin) => call('rejectApprovalsFromOrigin', { origin }),
  listRunningBatches: () => call('listRunningBatches'),
  stopBatch: (origin, id) => call('stopBatch', { origin, id }),
  resolveApproval: (id, approved, data) => call('resolveApproval', { id, approved, data }),
  prepareSend: (to, amount) => call('prepareSend', { to, amount }),
  confirmSend: (id) => call('confirmSend', { id }),
  getPreferences: () => call('getPreferences'),
  setPreferences: (preferences) => call('setPreferences', preferences),
  touch: () => call('touch'),
};
