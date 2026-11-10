// EIP-1193 provider injected into the page's MAIN world at document_start, announced via EIP-6963.
// It holds no secrets and makes no decisions; everything is forwarded to the extension.
// This file must stay dependency-free: content scripts cannot load ES module chunks.
(() => {
  const CHANNEL = 'injected-wallet-bridge';
  const EVENTS = new Set(['accountsChanged', 'chainChanged', 'connect', 'disconnect', 'message']);
  const INTERACTIVE_METHODS = new Set([
    'eth_requestAccounts',
    'wallet_requestPermissions',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'wallet_watchAsset',
    'personal_sign',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'wallet_sendCalls',
    'eth_sendTransaction',
  ]);
  const INTERACTIVE_TIMEOUT_MS = 15 * 60 * 1000;
  const DEFAULT_TIMEOUT_MS = 90 * 1000;
  const MAX_PENDING = 100;
  // crypto.randomUUID only exists in secure contexts; plain-http pages still need a UUIDv4.
  const uuidV4 = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const WALLET_INFO = Object.freeze({
    uuid: uuidV4(),
    name: 'Rakshit Wallet',
    // Replace rdns with a reverse-DNS name for a domain you control before publishing.
    rdns: 'com.rakshitwallet',
    // Same artwork as public/logo.svg (base64, so the page cannot be confused by markup).
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9InJ3LWJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMTliNDZhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDc1NDJmIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9InJ3LWxlZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZmYjU0NyIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2YyNjIxYSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiByeD0iMzAiIGZpbGw9InVybCgjcnctYmcpIi8+PHBhdGggZD0iTTAgOTZDMzAgODQgNzAgODQgMTI4IDEwNFYxMjhIMFoiIGZpbGw9IiMwMDAiIG9wYWNpdHk9IjAuMTAiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMCAwKSBza2V3WCgtMTApIiBmaWxsPSJub25lIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik00MiA5OFYzMWgyN2ExOS41IDE5LjUgMCAwIDEgMCAzOUg0MiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEzIi8+PHBhdGggZD0iTTYyIDcwbDI5IDI4IiBzdHJva2U9InVybCgjcnctbGVnKSIgc3Ryb2tlLXdpZHRoPSIxMyIvPjwvZz48Y2lyY2xlIGN4PSI5OSIgY3k9IjMwIiByPSI3IiBmaWxsPSJ1cmwoI3J3LWxlZykiLz48L3N2Zz4=',
  });

  class ProviderRpcError extends Error {
    constructor(code, message, data) {
      super(message);
      this.name = 'ProviderRpcError';
      this.code = code;
      if (data !== undefined) {
        this.data = data;
      }
    }
  }

  const prefix = Math.random().toString(36).slice(2);
  let counter = 0;

  class InjectedWalletProvider {
    #pending = new Map();
    #queue = [];
    #listeners = new Map();
    #relayReady = false;
    #accounts = [];
    #chainId = null;
    #connected = false;
    #refreshing = null;

    constructor() {
      this.isRakshitWallet = true;
      window.addEventListener('message', (event) => this.#onMessage(event));
      window.postMessage({ channel: CHANNEL, from: 'provider', type: 'hello' }, window.location.origin);
    }

    get chainId() {
      return this.#chainId;
    }

    get selectedAddress() {
      return this.#accounts[0] ?? null;
    }

    get networkVersion() {
      return this.#chainId ? BigInt(this.#chainId).toString(10) : null;
    }

    isConnected() {
      return this.#connected;
    }

    request(args) {
      if (!args || typeof args !== 'object' || typeof args.method !== 'string' || args.method.length === 0 || args.method.length > 128) {
        return Promise.reject(new ProviderRpcError(-32600, 'A valid wallet method is required.'));
      }
      if (args.params !== undefined && (typeof args.params !== 'object' || args.params === null)) {
        return Promise.reject(new ProviderRpcError(-32602, 'params must be an array or object.'));
      }
      if (this.#pending.size >= MAX_PENDING) {
        return Promise.reject(new ProviderRpcError(-32005, 'Too many pending wallet requests.'));
      }
      const id = `${prefix}-${++counter}`;
      const method = args.method;
      return new Promise((resolve, reject) => {
        const timeoutMs = INTERACTIVE_METHODS.has(method) ? INTERACTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
        const timeout = setTimeout(() => {
          this.#pending.delete(id);
          reject(new ProviderRpcError(-32603, 'Wallet request timed out.'));
        }, timeoutMs);
        this.#pending.set(id, { resolve, reject, timeout, method });
        const message = { channel: CHANNEL, from: 'provider', type: 'request', id, payload: { method, params: args.params } };
        if (this.#relayReady) {
          window.postMessage(message, window.location.origin);
        } else {
          this.#queue.push(message);
        }
      }).then((result) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          this.#setAccounts(result);
        } else if (method === 'eth_chainId') {
          this.#setChain(result);
        } else if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain' || method === 'wallet_revokePermissions') {
          this.#refresh();
        }
        return result;
      });
    }

    // Legacy APIs still used by older dApps.
    enable() {
      return this.request({ method: 'eth_requestAccounts' });
    }

    sendAsync(payload, callback) {
      this.request({ method: payload?.method, params: payload?.params }).then(
        (result) => callback(null, { id: payload?.id, jsonrpc: '2.0', result }),
        (error) => callback(error, { id: payload?.id, jsonrpc: '2.0', error: { code: error.code, message: error.message } }),
      );
    }

    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string') {
        return this.request({ method: methodOrPayload, params: paramsOrCallback });
      }
      if (typeof paramsOrCallback === 'function') {
        return this.sendAsync(methodOrPayload, paramsOrCallback);
      }
      throw new ProviderRpcError(4200, 'Synchronous send is not supported. Use request().');
    }

    on(eventName, listener) {
      if (EVENTS.has(eventName) && typeof listener === 'function') {
        if (!this.#listeners.has(eventName)) {
          this.#listeners.set(eventName, new Set());
        }
        this.#listeners.get(eventName).add(listener);
      }
      return this;
    }

    once(eventName, listener) {
      const wrapped = (payload) => {
        this.removeListener(eventName, wrapped);
        listener(payload);
      };
      return this.on(eventName, wrapped);
    }

    removeListener(eventName, listener) {
      this.#listeners.get(eventName)?.delete(listener);
      return this;
    }

    off(eventName, listener) {
      return this.removeListener(eventName, listener);
    }

    removeAllListeners(eventName) {
      if (eventName) {
        this.#listeners.delete(eventName);
      } else {
        this.#listeners.clear();
      }
      return this;
    }

    #emit(eventName, payload) {
      for (const listener of Array.from(this.#listeners.get(eventName) || [])) {
        try {
          listener(payload);
        } catch (error) {
          console.error(`Error in ${eventName} listener:`, error);
        }
      }
    }

    #onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }
      const data = event.data;
      if (!data || data.channel !== CHANNEL || data.from !== 'relay') {
        return;
      }
      if (data.type === 'ready') {
        if (!this.#relayReady) {
          this.#relayReady = true;
          for (const message of this.#queue.splice(0)) {
            window.postMessage(message, window.location.origin);
          }
          this.#refresh();
        }
        return;
      }
      if (data.type === 'event' && data.event === 'stateChanged') {
        this.#refresh();
        return;
      }
      if (data.type !== 'response' || typeof data.id !== 'string') {
        return;
      }
      const pending = this.#pending.get(data.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.#pending.delete(data.id);
      if (data.error) {
        pending.reject(
          new ProviderRpcError(
            Number.isInteger(data.error.code) ? data.error.code : -32603,
            typeof data.error.message === 'string' ? data.error.message : 'Wallet request failed.',
            data.error.data,
          ),
        );
      } else {
        pending.resolve(data.result);
      }
    }

    /** Re-reads chain and accounts after the wallet reports a state change. */
    #refresh() {
      if (this.#refreshing) {
        return this.#refreshing;
      }
      this.#refreshing = Promise.all([
        this.request({ method: 'eth_chainId' }),
        this.request({ method: 'eth_accounts' }),
      ])
        .catch((error) => {
          if (error?.code === 4900 && this.#connected) {
            this.#connected = false;
            this.#emit('disconnect', error);
          }
        })
        .finally(() => {
          this.#refreshing = null;
        });
      return this.#refreshing;
    }

    #setChain(chainId) {
      if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId)) {
        return;
      }
      const previous = this.#chainId;
      this.#chainId = chainId;
      if (!this.#connected) {
        this.#connected = true;
        this.#emit('connect', { chainId });
      } else if (previous !== chainId) {
        this.#emit('chainChanged', chainId);
      }
    }

    #setAccounts(accounts) {
      const next = Array.isArray(accounts) ? accounts.filter((a) => typeof a === 'string') : [];
      if (next.length === this.#accounts.length && next.every((account, index) => account === this.#accounts[index])) {
        return;
      }
      this.#accounts = next;
      this.#emit('accountsChanged', [...next]);
    }
  }

  const provider = new InjectedWalletProvider();

  function announce() {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: WALLET_INFO, provider }) }),
    );
  }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // Coexist with other wallets: never overwrite an existing window.ethereum; EIP-6963 handles discovery.
  if (typeof window.ethereum === 'undefined') {
    window.ethereum = provider;
    window.dispatchEvent(new Event('ethereum#initialized'));
  }
})();
