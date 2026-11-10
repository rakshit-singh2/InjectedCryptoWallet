// Isolated-world relay between the page's provider (MAIN world) and the background service worker.
// It forwards well-formed requests over a runtime port. The background derives the requesting origin
// from the port's sender metadata, so nothing the page says about its own identity is trusted.
// This file must stay dependency-free: content scripts cannot load ES module chunks.
(() => {
  const CHANNEL = 'injected-wallet-bridge';
  const PORT_NAME = 'wallet-provider';
  const MAX_REQUEST_CHARS = 512 * 1024;
  const MAX_OUTSTANDING = 100;
  const KEEPALIVE_MS = 20_000;

  let port = null;
  let keepaliveTimer = null;
  const outstanding = new Set();

  function toPage(message) {
    window.postMessage({ channel: CHANNEL, from: 'relay', ...message }, window.location.origin);
  }

  function respondError(id, code, message) {
    toPage({ type: 'response', id, error: { code, message } });
  }

  function stopKeepalive() {
    if (keepaliveTimer !== null && outstanding.size === 0) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function startKeepalive() {
    // While a request is outstanding (e.g. waiting for user approval) keep the worker from idling out,
    // because its in-memory approval resolver would otherwise be lost.
    if (keepaliveTimer === null) {
      keepaliveTimer = setInterval(() => {
        try {
          port?.postMessage({ type: 'keepalive' });
        } catch {
          // handled by onDisconnect
        }
      }, KEEPALIVE_MS);
    }
  }

  function getPort() {
    if (port) {
      return port;
    }
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((message) => {
      if (message?.type !== 'response' || typeof message.id !== 'string' || !outstanding.has(message.id)) {
        return;
      }
      outstanding.delete(message.id);
      stopKeepalive();
      toPage(message.error ? { type: 'response', id: message.id, error: message.error } : { type: 'response', id: message.id, result: message.result });
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      // Fail closed: the worker restarted or the extension was reloaded; pending approvals are gone.
      for (const id of outstanding) {
        respondError(id, 4900, 'The wallet connection was interrupted. Please retry.');
      }
      outstanding.clear();
      stopKeepalive();
    });
    return port;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.from !== 'provider') {
      return;
    }
    if (data.type === 'hello') {
      toPage({ type: 'ready' });
      return;
    }
    if (data.type !== 'request' || typeof data.id !== 'string' || data.id.length === 0 || data.id.length > 128) {
      return;
    }
    const payload = data.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof payload.method !== 'string' || payload.method.length === 0 || payload.method.length > 128) {
      respondError(data.id, -32600, 'A valid wallet method is required.');
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify({ method: payload.method, params: payload.params });
    } catch {
      respondError(data.id, -32600, 'Wallet request payload is not serialisable.');
      return;
    }
    if (serialized.length > MAX_REQUEST_CHARS) {
      respondError(data.id, -32600, 'Wallet request payload is too large.');
      return;
    }
    if (outstanding.has(data.id) || outstanding.size >= MAX_OUTSTANDING) {
      respondError(data.id, -32005, 'Too many pending wallet requests.');
      return;
    }
    try {
      outstanding.add(data.id);
      getPort().postMessage({ type: 'request', id: data.id, payload: JSON.parse(serialized) });
      startKeepalive();
    } catch {
      outstanding.delete(data.id);
      port = null;
      respondError(data.id, 4900, 'The wallet extension is unavailable.');
    }
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id || message?.type !== 'WALLET_STATE_CHANGED') {
      return;
    }
    toPage({ type: 'event', event: 'stateChanged' });
  });

  toPage({ type: 'ready' });
})();
