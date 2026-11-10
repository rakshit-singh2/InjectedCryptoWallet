import { VaultController } from './controllers/VaultController.js';
import { NetworkController } from './controllers/NetworkController.js';
import { PermissionController } from './controllers/PermissionController.js';
import { ApprovalController } from './controllers/ApprovalController.js';
import { TransactionController } from './controllers/TransactionController.js';
import { BatchController } from './controllers/BatchController.js';
import { createProviderHandler } from './rpc/providerMethods.js';
import { createPopupHandler } from './rpc/popupMethods.js';
import * as assetStore from '../shared/assetStore.js';

/** Wires controllers together. Kept separate from chrome event registration so it can be unit tested. */
export function createWallet({ notifyTabs = async () => {}, kdfIterations, fetchImpl, windows, runtime, alarms, rateLimiter, batchOptions } = {}) {
  const vault = new VaultController({ kdfIterations, alarms });
  const network = new NetworkController({ fetchImpl });
  const permissions = new PermissionController({ vault });
  const approvals = new ApprovalController({ windows, runtime });
  const transactions = new TransactionController({ network, vault, history: assetStore.addTransaction });
  const batch = new BatchController({ network, transactions, approvals, permissions, vault, ...batchOptions });


  const provider = createProviderHandler({ vault, network, permissions, approvals, transactions, batch, assets: assetStore, rateLimiter });
  const popup = createPopupHandler({ vault, network, permissions, approvals, transactions, batch, assets: assetStore, notifyTabs });

  vault.onLock(async () => {
    batch.cancelAll();
    approvals.rejectAll();
    popup.clearPendingSends();
    await notifyTabs();
  });
  network.onChainChanged(() => notifyTabs());
  permissions.onChange(async (origin) => {
    await batch.handlePermissionChange(origin).catch(() => {});
    await notifyTabs();
  });

  return { vault, network, permissions, approvals, transactions, batch, provider, popup };
}
