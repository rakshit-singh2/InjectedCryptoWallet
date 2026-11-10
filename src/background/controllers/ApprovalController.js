import { StorageKeys, getSession, setSession, removeSession } from '../store.js';
import { WalletError, ErrorCodes, rejected } from '../errors.js';

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_PENDING_PER_ORIGIN = 5;
const WINDOW_KEY = 'approvalWindowId';

/**
 * Queue of user approvals shown in a single extension-owned window.
 *
 * Resolvers live in memory, so a pending request can only be completed by the same service-worker
 * instance that received it. The queue is mirrored to chrome.storage.session purely so a restarted
 * worker can detect and discard orphaned prompts (fail closed) instead of showing dead approvals.
 */
export class ApprovalController {
  constructor({ windows = globalThis.chrome?.windows, runtime = globalThis.chrome?.runtime } = {}) {
    this.windows = windows;
    this.runtime = runtime;
    this.pending = new Map();
    this.windowId = null;
    this.openingWindow = null;
  }

  /** Called once at worker start-up: anything persisted but not in memory is orphaned. */
  async discardOrphans() {
    const stale = (await getSession(StorageKeys.approvals)) || [];
    const windowId = await getSession(WINDOW_KEY);
    await removeSession([StorageKeys.approvals, WINDOW_KEY]);
    if (stale.length && Number.isInteger(windowId)) {
      try {
        await this.windows?.remove(windowId);
      } catch {
        // window already gone
      }
    }
  }

  list() {
    return Array.from(this.pending.values()).map(({ record }) => record);
  }

  get(id) {
    return this.pending.get(id)?.record || null;
  }

  async persist() {
    await setSession({ [StorageKeys.approvals]: this.list() });
  }

  /** Throws if a new approval from `origin` would be refused; lets callers fail before expensive work. */
  assertCanRequest(origin, exclusiveKey) {
    if (exclusiveKey && this.list().some((record) => record.exclusiveKey === exclusiveKey)) {
      throw new WalletError(ErrorCodes.resourceUnavailable, 'A request of this type is already pending. Check the wallet window.');
    }
    if (this.pending.size >= MAX_PENDING) {
      throw new WalletError(ErrorCodes.limitExceeded, 'Too many pending wallet approvals.');
    }
    if (this.list().filter((record) => record.origin === origin).length >= MAX_PENDING_PER_ORIGIN) {
      throw new WalletError(ErrorCodes.limitExceeded, 'This site has too many pending approvals.');
    }
  }

  /**
   * Adds an approval and resolves with the user's decision data, or rejects with 4001.
   * `exclusiveKey` prevents duplicate prompts (e.g. two connection requests from one origin).
   */
  async request({ origin, type, params, exclusiveKey }) {
    this.assertCanRequest(origin, exclusiveKey);

    const id = crypto.randomUUID();
    const record = Object.freeze({ id, origin, type, params, exclusiveKey: exclusiveKey || null, createdAt: Date.now() });
    const decision = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, false), APPROVAL_TIMEOUT_MS);
      this.pending.set(id, { record, resolve, reject, timer });
    });
    await this.persist();
    try {
      await this.showWindow();
    } catch (error) {
      this.settle(id, false);
      throw new WalletError(ErrorCodes.internal, 'Could not open the approval window.');
    }
    return decision;
  }

  /** Completes an approval. Only the background calls this, after authenticating the sender. */
  settle(id, approved, data) {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (approved) {
      entry.resolve(data ?? {});
    } else {
      entry.reject(rejected());
    }
    this.persist().catch(() => {});
    return true;
  }

  /** Lets the user clear a flood of prompts from one site in a single action. */
  rejectOrigin(origin) {
    let count = 0;
    for (const { record } of Array.from(this.pending.values())) {
      if (record.origin === origin && this.settle(record.id, false)) {
        count += 1;
      }
    }
    return count;
  }

  rejectAll() {
    for (const id of Array.from(this.pending.keys())) {
      this.settle(id, false);
    }
  }

  async showWindow() {
    if (!this.windows) {
      throw new Error('windows API unavailable');
    }
    if (this.windowId !== null) {
      try {
        await this.windows.update(this.windowId, { focused: true });
        return;
      } catch {
        this.windowId = null;
      }
    }
    if (!this.openingWindow) {
      this.openingWindow = (async () => {
        const created = await this.windows.create({
          url: this.runtime.getURL('index.html#/approval'),
          type: 'popup',
          width: 400,
          height: 640,
          focused: true,
        });
        this.windowId = created.id;
        await setSession({ [WINDOW_KEY]: created.id });
      })().finally(() => {
        this.openingWindow = null;
      });
    }
    await this.openingWindow;
  }

  /**
   * Called by the approval UI when its queue looks empty. Atomically (the worker is single-threaded)
   * either keeps the window because something new arrived, or forgets it so the next request opens
   * a fresh window and the upcoming close event cannot reject that request.
   */
  releaseWindow() {
    if (this.pending.size > 0) {
      return false;
    }
    this.windowId = null;
    removeSession([WINDOW_KEY]).catch(() => {});
    return true;
  }

  /** Closing the approval window rejects everything still queued in it. */
  handleWindowRemoved(windowId) {
    if (windowId !== this.windowId) {
      return;
    }
    this.windowId = null;
    removeSession([WINDOW_KEY]).catch(() => {});
    this.rejectAll();
  }
}
