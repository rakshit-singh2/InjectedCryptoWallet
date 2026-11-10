import { StorageKeys, getLocal, setLocal } from '../store.js';
import { invalidParams } from '../errors.js';
import { isValidHttpOrigin, sameAddress } from '../validation.js';

/** Normalises both the legacy `{origin: [address]}` shape and the current `{origin: {accounts, grantedAt}}`. */
function normalizeEntry(value) {
  if (Array.isArray(value)) {
    return { accounts: value, grantedAt: 0 };
  }
  if (value && Array.isArray(value.accounts)) {
    return { accounts: value.accounts, grantedAt: Number(value.grantedAt) || 0 };
  }
  return null;
}

/** Per-origin `eth_accounts` permissions (EIP-2255 shaped). Origins come from browser sender metadata only. */
export class PermissionController {
  constructor({ vault, now = () => Date.now() }) {
    this.vault = vault;
    this.now = now;
    this.listeners = new Set();
  }

  onChange(listener) {
    this.listeners.add(listener);
  }

  async notify(origin) {
    for (const listener of this.listeners) {
      await listener(origin);
    }
  }

  async readAll() {
    const stored = (await getLocal(StorageKeys.permissions)) || {};
    const result = {};
    for (const [origin, value] of Object.entries(stored)) {
      const entry = normalizeEntry(value);
      if (isValidHttpOrigin(origin) && entry && entry.accounts.length) {
        result[origin] = entry;
      }
    }
    return result;
  }

  /** Accounts the origin may see, filtered to accounts that still exist, selected account first. */
  async getPermittedAccounts(origin) {
    const entry = (await this.readAll())[origin];
    if (!entry) {
      return [];
    }
    const accounts = await this.vault.getAccounts();
    const permitted = accounts
      .filter((account) => entry.accounts.some((allowed) => sameAddress(allowed, account.address)))
      .map((account) => account.address);
    const selected = await this.vault.getSelectedAddress();
    const selectedIndex = permitted.findIndex((address) => sameAddress(address, selected));
    if (selectedIndex > 0) {
      permitted.unshift(...permitted.splice(selectedIndex, 1));
    }
    return permitted;
  }

  async isPermitted(origin, address) {
    return (await this.getPermittedAccounts(origin)).some((permitted) => sameAddress(permitted, address));
  }

  async grant(origin, addresses) {
    if (!isValidHttpOrigin(origin)) {
      throw invalidParams('Invalid origin.');
    }
    const accounts = await this.vault.getAccounts();
    const granted = addresses.map((address) => {
      const match = accounts.find((account) => sameAddress(account.address, address));
      if (!match) {
        throw invalidParams('Cannot grant access to an unknown account.');
      }
      return match.address;
    });
    if (!granted.length) {
      throw invalidParams('Select at least one account.');
    }
    const stored = (await getLocal(StorageKeys.permissions)) || {};
    stored[origin] = { accounts: [...new Set(granted)], grantedAt: this.now() };
    await setLocal({ [StorageKeys.permissions]: stored });
    await this.notify(origin);
    return stored[origin].accounts;
  }

  async revoke(origin) {
    if (!isValidHttpOrigin(origin)) {
      throw invalidParams('Invalid origin.');
    }
    const stored = (await getLocal(StorageKeys.permissions)) || {};
    if (!Object.prototype.hasOwnProperty.call(stored, origin)) {
      return false;
    }
    delete stored[origin];
    await setLocal({ [StorageKeys.permissions]: stored });
    await this.notify(origin);
    return true;
  }

  async list() {
    const all = await this.readAll();
    return Object.entries(all).map(([origin, entry]) => ({ origin, accounts: entry.accounts, grantedAt: entry.grantedAt }));
  }

  /** EIP-2255 `wallet_getPermissions` result for an origin. */
  async describe(origin) {
    const entry = (await this.readAll())[origin];
    const accounts = await this.getPermittedAccounts(origin);
    if (!entry || !accounts.length) {
      return [];
    }
    return [
      {
        invoker: origin,
        parentCapability: 'eth_accounts',
        caveats: [{ type: 'restrictReturnedAccounts', value: accounts }],
        date: entry.grantedAt,
      },
    ];
  }

  /** Drops accounts that no longer exist (e.g. imported keys removed during a seed reset). */
  async pruneMissingAccounts() {
    const accounts = await this.vault.getAccounts();
    const stored = await this.readAll();
    const next = {};
    for (const [origin, entry] of Object.entries(stored)) {
      const remaining = entry.accounts.filter((address) => accounts.some((a) => sameAddress(a.address, address)));
      if (remaining.length) {
        next[origin] = { ...entry, accounts: remaining };
      }
    }
    await setLocal({ [StorageKeys.permissions]: next });
  }
}
