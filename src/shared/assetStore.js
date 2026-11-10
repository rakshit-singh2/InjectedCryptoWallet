// Non-secret per-account data (watched tokens, NFTs, transaction history) in IndexedDB.
// Shared by the popup and the background service worker; it must not touch
// localStorage/sessionStorage/window because the service worker has none of them.
import { openDB } from 'idb';

export const DB_NAME = 'cryptoWallet';
export const DB_VERSION = 2;
const WALLET_STORE = 'walletData';
const CHAIN_STORE = 'chainData'; // legacy (v1) only; read during migration
const USER_STORE = 'userData'; // legacy (v1) only; read during migration
const LEGACY_USER_ID = 'KuchBhi';
const MAX_HISTORY = 500;

let dbPromise;

export function openAssetDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains(WALLET_STORE)) {
          db.createObjectStore(WALLET_STORE, { keyPath: 'address' });
        } else if (oldVersion < 2) {
          // v1 declared unique indexes on optional fields (pinned/imported/walletKey) which would
          // reject a second account with the same value. Only indexes are dropped; records are kept.
          const store = transaction.objectStore(WALLET_STORE);
          for (const name of Array.from(store.indexNames)) {
            store.deleteIndex(name);
          }
        }
        // chainData/userData are left untouched so the background can migrate them.
      },
    });
  }
  return dbPromise;
}

/** For tests: forget the cached connection. */
export function resetAssetDbForTests() {
  dbPromise = undefined;
}

const key = (address) => address.toLowerCase();

async function readRecord(db, address) {
  // v1 records were keyed by checksummed address; v2 uses lowercase. Look up both.
  return (await db.get(WALLET_STORE, key(address))) || (await db.get(WALLET_STORE, address)) || null;
}

async function updateRecord(address, mutate) {
  const db = await openAssetDb();
  const tx = db.transaction(WALLET_STORE, 'readwrite');
  const existing =
    (await tx.store.get(key(address))) || (await tx.store.get(address)) || { address: key(address) };
  const next = mutate({ tokens: [], Nfts: [], transactions: [], ...existing });
  if (existing.address !== key(address)) {
    await tx.store.delete(existing.address);
  }
  await tx.store.put({ ...next, address: key(address) });
  await tx.done;
  return next;
}

const sameContract = (a, b) =>
  a.address?.toLowerCase() === b.address?.toLowerCase() && a.chain === b.chain;

export async function getTokens(address, chainId) {
  const record = await readRecord(await openAssetDb(), address);
  return (record?.tokens || []).filter((token) => token.chain === chainId);
}

export async function addToken(address, token) {
  await updateRecord(address, (record) => {
    if (record.tokens.some((existing) => sameContract(existing, token))) {
      throw new Error('This token is already in your list.');
    }
    return { ...record, tokens: [...record.tokens, token] };
  });
}

export async function getNFTs(address, chainId) {
  const record = await readRecord(await openAssetDb(), address);
  return (record?.Nfts || []).filter((nft) => nft.chain === chainId);
}

export async function addNFT(address, nft) {
  await updateRecord(address, (record) => {
    if (record.Nfts.some((existing) => sameContract(existing, nft))) {
      throw new Error('This NFT contract is already in your list.');
    }
    return { ...record, Nfts: [...record.Nfts, nft] };
  });
}

/**
 * History entries: { transactionHash, from, to, amount, chainId, chainName, origin, timestamp }.
 * Legacy entries only carry chainName, so filtering accepts either field.
 */
export async function getTransactions(address, network) {
  const record = await readRecord(await openAssetDb(), address);
  return (record?.transactions || [])
    .filter((tx) => (tx.chainId ? tx.chainId === network.chainId : tx.chainName === network.name))
    .slice()
    .reverse();
}

export async function addTransaction(address, entry) {
  await updateRecord(address, (record) => ({
    ...record,
    transactions: [...record.transactions, entry].slice(-MAX_HISTORY),
  }));
}

// ---------------- Legacy (v1) access used only by the migration ----------------

export async function readLegacyWalletRecords() {
  const db = await openAssetDb();
  return db.getAll(WALLET_STORE);
}

export async function readLegacyChains() {
  const db = await openAssetDb();
  return db.objectStoreNames.contains(CHAIN_STORE) ? db.getAll(CHAIN_STORE) : [];
}

export async function readLegacyUserData() {
  const db = await openAssetDb();
  return db.objectStoreNames.contains(USER_STORE) ? (await db.get(USER_STORE, LEGACY_USER_ID)) || null : null;
}

/** Removes migrated secrets from IndexedDB records. Non-secret fields are kept. */
export async function stripLegacyWalletKeys() {
  const db = await openAssetDb();
  const tx = db.transaction(WALLET_STORE, 'readwrite');
  for (const record of await tx.store.getAll()) {
    if ('walletKey' in record) {
      const { walletKey: _removed, ...rest } = record;
      await tx.store.put(rest);
    }
  }
  await tx.done;

  if (db.objectStoreNames.contains(USER_STORE)) {
    // The only remaining sensitive field in userData is the legacy password verifier.
    const userTx = db.transaction(USER_STORE, 'readwrite');
    const user = await userTx.store.get(LEGACY_USER_ID);
    if (user && 'password' in user) {
      const { password: _verifier, ...rest } = user;
      await userTx.store.put(rest);
    }
    await userTx.done;
  }
}
