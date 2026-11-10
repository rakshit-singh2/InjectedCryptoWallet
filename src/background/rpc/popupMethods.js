import { parseEther } from 'ethers';
import { WalletError, ErrorCodes, invalidParams } from '../errors.js';
import { normalizeAddress, sameAddress } from '../validation.js';
import { normalizeTransactionRequest } from '../controllers/TransactionController.js';
import { migrateLegacyWallet } from '../legacyMigration.js';

const SEND_PROPOSAL_TTL_MS = 2 * 60 * 1000;

// Read/poll methods must not count as activity: the approval window polls continuously and a
// website can keep it open, which would otherwise defeat auto-lock indefinitely.
const PASSIVE_METHODS = new Set(['getState', 'listApprovals', 'releaseApprovalWindow', 'getPreferences', 'listPermissions', 'listRunningBatches']);

/**
 * Methods available to extension pages (popup + approval window). The caller must already have been
 * authenticated as an extension page. Private keys never leave the background except through
 * exportPrivateKey, which re-checks the password.
 */
export function createPopupHandler({ vault, network, permissions, approvals, transactions, batch, assets, notifyTabs }) {
  const pendingSends = new Map();

  async function requireUnlocked() {
    if (!(await vault.isUnlocked())) {
      throw new WalletError(ErrorCodes.unauthorized, 'The wallet is locked.');
    }
  }

  const handlers = {
    async getState() {
      const initialized = await vault.isInitialized();
      const unlocked = initialized && (await vault.isUnlocked());
      return {
        initialized,
        unlocked,
        accounts: initialized ? await vault.getAccounts() : [],
        selectedAddress: initialized ? await vault.getSelectedAddress() : null,
        networks: await network.getNetworks(),
        selectedChainId: await network.getSelectedChainId(),
        pendingApprovals: approvals.list().length,
      };
    },

    async createVault({ mnemonic, password }) {
      await vault.createVault({ mnemonic, password });
      await notifyTabs();
      return true;
    },

    async unlock({ password }) {
      await vault.unlock(password);
      await notifyTabs();
      return true;
    },

    async lock() {
      await vault.lock();
      return true;
    },

    async migrateLegacy({ password, seedRecord }) {
      const result = await migrateLegacyWallet({ vault, network, assets, password, legacySeedRecord: seedRecord });
      await notifyTabs();
      return result;
    },

    async resetWithMnemonic({ mnemonic, password, confirmDropImported }) {
      const result = await vault.resetWithMnemonic({ mnemonic, password, confirmDropImported: confirmDropImported === true });
      await permissions.pruneMissingAccounts();
      await notifyTabs();
      return result;
    },

    async addAccount({ name } = {}) {
      await requireUnlocked();
      const account = await vault.addHdAccount(name);
      await notifyTabs();
      return account;
    },

    async importAccount({ privateKey, name }) {
      await requireUnlocked();
      const account = await vault.importAccount(privateKey, name);
      await notifyTabs();
      return account;
    },

    async renameAccount({ address, name }) {
      await requireUnlocked();
      await vault.renameAccount(address, name);
      return true;
    },

    async selectAccount({ address }) {
      await requireUnlocked();
      await vault.selectAccount(address);
      await notifyTabs();
      return true;
    },

    async exportPrivateKey({ address, password }) {
      return vault.exportPrivateKey(address, password);
    },

    async selectNetwork({ chainId }) {
      await requireUnlocked();
      return network.setSelectedChainId(chainId);
    },

    async addNetwork(definition) {
      await requireUnlocked();
      return network.addNetwork(definition);
    },

    async editNetwork({ chainId, ...changes }) {
      await requireUnlocked();
      return network.editNetwork(chainId, changes);
    },

    async removeNetwork({ chainId }) {
      await requireUnlocked();
      await network.removeNetwork(chainId);
      return true;
    },

    async listPermissions() {
      await requireUnlocked();
      return permissions.list();
    },

    async revokePermission({ origin }) {
      await requireUnlocked();
      return permissions.revoke(origin);
    },

    async listApprovals() {
      return approvals.list();
    },

    async rejectApprovalsFromOrigin({ origin }) {
      return approvals.rejectOrigin(origin);
    },

    async listRunningBatches() {
      return batch ? batch.listRunning() : [];
    },

    // Stopping is always allowed, even while locked: it can only prevent signing.
    async stopBatch({ origin, id }) {
      if (typeof origin !== 'string' || typeof id !== 'string') {
        throw invalidParams('Expected a batch origin and id.');
      }
      return batch ? batch.stop(origin, id) : false;
    },

    async releaseApprovalWindow() {
      return approvals.releaseWindow();
    },

    async resolveApproval({ id, approved, data }) {
      const record = approvals.get(id);
      if (!record) {
        throw invalidParams('This request is no longer pending.');
      }
      if (!approved) {
        approvals.settle(id, false);
        return true;
      }
      await requireUnlocked();
      let decision = {};
      if (record.type === 'connect') {
        const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
        const known = await vault.getAccounts();
        if (!accounts.length || !accounts.every((address) => known.some((account) => sameAddress(account.address, address)))) {
          throw invalidParams('Select at least one of your accounts.');
        }
        decision = { accounts: accounts.map((address) => normalizeAddress(address)) };
      }
      approvals.settle(id, true, decision);
      return true;
    },

    /** Wallet-initiated native transfer: step 1 builds an immutable proposal for review. */
    async prepareSend({ to, amount }) {
      await requireUnlocked();
      let value;
      try {
        value = parseEther(String(amount ?? '').trim());
      } catch {
        throw invalidParams('Enter a valid amount.');
      }
      if (value <= 0n) {
        throw invalidParams('Amount must be greater than zero.');
      }
      const from = await vault.getSelectedAddress();
      const recipient = normalizeAddress(String(to ?? '').trim(), 'recipient address');
      if (sameAddress(recipient, from)) {
        throw invalidParams('Sender and recipient are the same account.');
      }
      const chainId = await network.getSelectedChainId();
      const request = normalizeTransactionRequest({ from, to: recipient, value: `0x${value.toString(16)}` }, { chainId });
      const proposal = Object.freeze(await transactions.prepare(request, chainId));
      const id = crypto.randomUUID();
      pendingSends.set(id, { proposal, expires: Date.now() + SEND_PROPOSAL_TTL_MS });
      return { id, ...proposal };
    },

    /** Step 2 signs exactly the reviewed proposal. */
    async confirmSend({ id }) {
      await requireUnlocked();
      const entry = pendingSends.get(id);
      pendingSends.delete(id);
      if (!entry || entry.expires < Date.now()) {
        throw invalidParams('This transfer review has expired. Review it again.');
      }
      return transactions.signAndSend(entry.proposal, { origin: 'wallet' });
    },

    async getPreferences() {
      return vault.getPreferences();
    },

    async setPreferences({ autoLockMinutes }) {
      await requireUnlocked();
      return vault.setPreferences({ autoLockMinutes });
    },

    async touch() {
      return true; // handle() already reset the timer; called by the UI on real keyboard/pointer input
    },
  };

  return {
    clearPendingSends() {
      pendingSends.clear();
    },
    async handle(method, params) {
      if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, method)) {
        throw new WalletError(ErrorCodes.methodNotFound, 'Unknown wallet UI method.');
      }
      if (!PASSIVE_METHODS.has(method)) {
        vault.touch();
      }
      return handlers[method](params && typeof params === 'object' ? params : {});
    },
  };
}
