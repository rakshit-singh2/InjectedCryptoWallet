// Password-based authenticated encryption for the wallet vault (Web Crypto only).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const VAULT_VERSION = 2;
export const DEFAULT_KDF_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const MIN_KDF_ITERATIONS = 1_000; // floor accepted only so unit tests can run quickly

export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(password, salt, iterations, extractable) {
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptWithKey(key, kdf, plaintextObject) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(plaintextObject)),
  );
  return {
    version: VAULT_VERSION,
    kdf,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptWithKey(key, record) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv) },
    key,
    fromBase64(record.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

export function isVaultRecord(record) {
  return Boolean(
    record &&
      record.version === VAULT_VERSION &&
      record.kdf?.name === 'PBKDF2' &&
      record.kdf?.hash === 'SHA-256' &&
      Number.isInteger(record.kdf?.iterations) &&
      record.kdf.iterations >= MIN_KDF_ITERATIONS &&
      typeof record.kdf?.salt === 'string' &&
      typeof record.iv === 'string' &&
      typeof record.ciphertext === 'string',
  );
}

/** Creates a fresh key + KDF parameters for a new password. */
export async function createVaultKey(password, iterations = DEFAULT_KDF_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < MIN_KDF_ITERATIONS) {
    throw new Error('Invalid KDF iteration count.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveAesKey(password, salt, iterations, true);
  return { key, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) } };
}

/** Derives the key for an existing record and decrypts it. Throws on a wrong password or tampering. */
export async function unlockVaultRecord(password, record) {
  if (!isVaultRecord(record)) {
    throw new Error('Unsupported vault format.');
  }
  const key = await deriveAesKey(password, fromBase64(record.kdf.salt), record.kdf.iterations, true);
  const secrets = await decryptWithKey(key, record);
  return { key, secrets };
}

export async function exportKey(key) {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function importKey(rawBase64) {
  return crypto.subtle.importKey('raw', fromBase64(rawBase64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// ---- Legacy (v1) records written by the pre-background popup implementation ----
const LEGACY_ITERATIONS = 310_000;

export async function decryptLegacySecret(record, password) {
  if (!record || typeof record !== 'object' || !record.ciphertext || !record.iv || !record.salt) {
    throw new Error('Unsupported legacy secret format.');
  }
  const key = await deriveAesKey(password, fromBase64(record.salt), LEGACY_ITERATIONS, false);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv) },
    key,
    fromBase64(record.ciphertext),
  );
  return decoder.decode(plaintext);
}
