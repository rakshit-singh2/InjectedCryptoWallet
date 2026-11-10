// One-time, idempotent migration from the v1 popup-owned storage layout:
//   localStorage['wallet-secure-vault']  -> AES-GCM(PBKDF2 310k) encrypted mnemonic (read by the popup and passed in)
//   IndexedDB walletData.walletKey       -> per-account private key (encrypted, or plaintext in very old builds)
//   IndexedDB chainData / userData       -> networks, last chain, HD child count
// Nothing is deleted until the new vault has been written successfully.
import { HDNodeWallet, Wallet, getAddress } from 'ethers';
import { decryptLegacySecret } from './vaultCrypto.js';
import { normalizeMnemonic } from './controllers/VaultController.js';
import { WalletError, ErrorCodes } from './errors.js';
import { normalizeChainId, sameAddress } from './validation.js';
import { StorageKeys } from './store.js';
import { builtInNetworkMap, DEFAULT_CHAIN_ID } from '../shared/networks.js';

const DERIVATION_LOOKAHEAD = 20;

function parseRecord(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

export async function migrateLegacyWallet({ vault, network, assets, password, legacySeedRecord }) {
  if (await vault.isInitialized()) {
    // A previous run may have written the vault but failed to strip legacy keys; retry (idempotent).
    await assets.stripLegacyWalletKeys();
    return { alreadyMigrated: true, migratedAccounts: 0 };
  }

  const seedRecord = parseRecord(legacySeedRecord);
  if (!seedRecord) {
    throw new WalletError(ErrorCodes.invalidParams, 'No legacy wallet data was provided.');
  }

  await vault.assertNotThrottled();
  let mnemonic;
  try {
    mnemonic = normalizeMnemonic(await decryptLegacySecret(seedRecord, String(password ?? '')));
  } catch {
    await vault.recordFailedUnlock();
    throw new WalletError(ErrorCodes.unauthorized, 'Incorrect password.');
  }

  const records = await assets.readLegacyWalletRecords();
  const userData = await assets.readLegacyUserData();
  const childCount = Math.max(parseInt(userData?.childCount, 10) || 1, records.length);

  const hdByAddress = new Map();
  for (let index = 0; index < childCount + DERIVATION_LOOKAHEAD; index += 1) {
    const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
    hdByAddress.set(wallet.address.toLowerCase(), index);
  }

  const accounts = [];
  const importedKeys = {};
  const encryptedBackups = {};
  const sorted = [...records].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
  for (const record of sorted) {
    let address;
    try {
      address = getAddress(String(record.address).toLowerCase());
    } catch {
      continue; // not an account row
    }
    if (!('walletKey' in record) && !hdByAddress.has(address.toLowerCase())) {
      continue; // asset-only row written after a previous partial migration
    }
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 32) : `Account ${accounts.length + 1}`;
    if (hdByAddress.has(address.toLowerCase())) {
      accounts.push({ address, name, type: 'hd', index: hdByAddress.get(address.toLowerCase()) });
      continue;
    }

    let privateKey;
    if (typeof record.walletKey === 'string' && /^0x[0-9a-f]{64}$/i.test(record.walletKey)) {
      privateKey = record.walletKey;
    } else {
      try {
        privateKey = await decryptLegacySecret(parseRecord(record.walletKey), String(password));
      } catch {
        throw new WalletError(ErrorCodes.internal, `Could not decrypt the key for ${address}. Nothing was changed.`);
      }
      encryptedBackups[address.toLowerCase()] = record.walletKey;
    }
    const wallet = new Wallet(privateKey);
    if (!sameAddress(wallet.address, address)) {
      throw new WalletError(ErrorCodes.internal, `Stored key does not match ${address}. Nothing was changed.`);
    }
    importedKeys[address.toLowerCase()] = wallet.privateKey;
    accounts.push({ address, name, type: 'imported' });
  }

  if (!accounts.some((account) => account.type === 'hd' && account.index === 0)) {
    const first = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
    accounts.unshift({ address: first.address, name: 'Account 1', type: 'hd', index: 0 });
  }

  // Networks: keep built-ins (with fixed chain IDs and key-less RPCs), carry over valid custom ones.
  const networks = builtInNetworkMap();
  for (const chain of await assets.readLegacyChains()) {
    try {
      const chainId = normalizeChainId(chain.hex);
      if (networks[chainId]) {
        continue;
      }
      networks[chainId] = await network.validateNetwork(
        { chainId, name: chain.name, ticker: chain.ticker, rpcUrl: chain.rpcUrl, blockExplorerUrl: chain.blockExplorerUrl },
        { verifyRpc: false },
      );
    } catch {
      // skip malformed legacy entries
    }
  }
  let selectedChainId = DEFAULT_CHAIN_ID;
  try {
    const last = normalizeChainId(userData?.lastChain);
    if (networks[last]) {
      selectedChainId = last;
    }
  } catch {
    // keep default
  }

  await vault.writeNewVault({
    password,
    secrets: { mnemonic, importedKeys },
    accounts,
    selectedAddress: accounts[0].address,
    extra: {
      [StorageKeys.networks]: networks,
      [StorageKeys.selectedChainId]: selectedChainId,
      // Still encrypted with the old password; kept so a failed upgrade can be recovered manually.
      [StorageKeys.legacyBackup]: { migratedAt: Date.now(), seedRecord, walletKeys: encryptedBackups },
    },
  });

  await assets.stripLegacyWalletKeys();
  return { alreadyMigrated: false, migratedAccounts: accounts.length };
}
