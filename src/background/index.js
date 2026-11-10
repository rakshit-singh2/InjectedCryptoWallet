// Extension service worker: the wallet's trust anchor. It owns the vault, keys, permissions,
// networks and approvals. Pages talk to it only through the content-script port; extension
// pages (popup / approval window) use runtime messages.
import { createWallet } from './wallet.js';
import { AUTO_LOCK_ALARM } from './controllers/VaultController.js';
import { restrictSessionAccess } from './store.js';
import { ErrorCodes, WalletError, toSerializableError } from './errors.js';
import { isValidHttpOrigin } from './validation.js';
import { stripLegacyWalletKeys } from '../shared/assetStore.js';

const PROVIDER_PORT = 'wallet-provider';
const MAX_PAYLOAD_CHARS = 512 * 1024;
const MAX_IN_FLIGHT_PER_PORT = 50;

/** Pings every tab; each content script asks its provider to re-read accounts/chain for its own origin. */
async function notifyTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (Number.isInteger(tab.id)) {
      chrome.tabs.sendMessage(tab.id, { type: 'WALLET_STATE_CHANGED' }, () => void chrome.runtime.lastError);
    }
  }
}

const wallet = createWallet({ notifyTabs });

const ready = (async () => {
  await restrictSessionAccess().catch(() => {});
  // A fresh worker has no in-memory resolvers, so any persisted prompt is orphaned: discard it.
  await wallet.approvals.discardOrphans().catch(() => {});
  // Batches that were running in a previous worker are marked stopped; unsent calls are never resumed.
  await wallet.batch.restore().catch(() => {});
  // Finish any interrupted v1 migration clean-up: remove legacy key material once a v2 vault exists.
  if (await wallet.vault.isInitialized().catch(() => false)) {
    await stripLegacyWalletKeys().catch(() => {});
  }
})();

function isExtensionPage(sender) {
  // Content scripts report the page URL here, so only genuine extension pages match.
  return sender?.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

/** The origin comes only from browser-provided sender metadata, never from page-supplied data. */
function trustedPageOrigin(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) {
    return null;
  }
  let origin = typeof sender.origin === 'string' ? sender.origin : null;
  if (!origin && typeof sender.url === 'string') {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return isValidHttpOrigin(origin) ? origin : null;
}

chrome.runtime.onConnect.addListener((port) => {
  const origin = port.name === PROVIDER_PORT ? trustedPageOrigin(port.sender) : null;
  if (!origin) {
    port.disconnect();
    return;
  }
  let inFlight = 0;
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
  });
  const reply = (message) => {
    if (connected) {
      try {
        port.postMessage(message);
      } catch {
        connected = false;
      }
    }
  };

  port.onMessage.addListener(async (message) => {
    if (message?.type === 'keepalive') {
      return; // receiving the message is enough to reset the worker's idle timer
    }
    if (message?.type !== 'request' || typeof message.id !== 'string' || message.id.length > 128) {
      return;
    }
    const { id, payload } = message;
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = null;
    }
    if (!serialized || serialized.length > MAX_PAYLOAD_CHARS) {
      reply({ type: 'response', id, error: { code: ErrorCodes.invalidRequest, message: 'Invalid or oversized request.' } });
      return;
    }
    if (inFlight >= MAX_IN_FLIGHT_PER_PORT) {
      reply({ type: 'response', id, error: { code: ErrorCodes.limitExceeded, message: 'Too many pending wallet requests.' } });
      return;
    }
    inFlight += 1;
    try {
      await ready;
      const result = await wallet.provider.handle(origin, JSON.parse(serialized));
      reply({ type: 'response', id, result: result === undefined ? null : result });
    } catch (error) {
      reply({ type: 'response', id, error: toSerializableError(error) });
    } finally {
      inFlight -= 1;
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'wallet-ui') {
    return false;
  }
  if (!isExtensionPage(sender)) {
    sendResponse({ error: toSerializableError(new WalletError(ErrorCodes.unauthorized, 'Unauthorized.')) });
    return false;
  }
  ready
    .then(() => wallet.popup.handle(message.method, message.params))
    .then((result) => sendResponse({ result: result === undefined ? null : result }))
    .catch((error) => sendResponse({ error: toSerializableError(error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    wallet.vault.lock().catch(() => {});
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  wallet.approvals.handleWindowRemoved(windowId);
});
