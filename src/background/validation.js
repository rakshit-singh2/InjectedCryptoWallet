import { getAddress, isAddress } from 'ethers';
import { invalidParams } from './errors.js';

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i;
const DATA = /^0x([0-9a-f]{2})*$/i;
const MAX_CHAIN_ID = 2n ** 53n - 1n; // keeps chain IDs representable as JS numbers (EIP-2015 guidance)

export function isHexQuantity(value) {
  return typeof value === 'string' && QUANTITY.test(value);
}

export function isHexData(value) {
  return typeof value === 'string' && DATA.test(value);
}

/** Returns a canonical lowercase 0x chain id or throws. */
export function normalizeChainId(value) {
  if (typeof value !== 'string' || !QUANTITY.test(value)) {
    throw invalidParams('Chain ID must be a 0x-prefixed hexadecimal string without leading zeros.');
  }
  const asBigInt = BigInt(value);
  if (asBigInt <= 0n || asBigInt > MAX_CHAIN_ID) {
    throw invalidParams('Chain ID is out of range.');
  }
  return `0x${asBigInt.toString(16)}`;
}

/** Returns a checksummed address or throws. */
export function normalizeAddress(value, label = 'address') {
  if (typeof value !== 'string' || !isAddress(value) || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw invalidParams(`Invalid ${label}.`);
  }
  return getAddress(value.toLowerCase());
}

export function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates a network URL. HTTPS is required except for loopback development nodes.
 * Embedded credentials and fragments are rejected so they can't leak to explorers or logs.
 */
export function normalizeRpcUrl(value, { label = 'RPC URL', allowLoopbackHttp = true } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw invalidParams(`${label} is required.`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidParams(`${label} is not a valid URL.`);
  }
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw invalidParams(`${label} must use https:// (http:// is allowed only for localhost).`);
  }
  if (url.username || url.password) {
    throw invalidParams(`${label} must not contain credentials.`);
  }
  if (url.hash) {
    throw invalidParams(`${label} must not contain a fragment.`);
  }
  // Drop the trailing slash URL() adds to a bare host so stored URLs match what users typed.
  return url.pathname === '/' && !url.search ? url.origin : url.href;
}

export function normalizeExplorerUrl(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  return normalizeRpcUrl(value, { label: 'Block explorer URL', allowLoopbackHttp: false });
}

export function normalizeText(value, label, { min = 1, max = 64 } = {}) {
  if (typeof value !== 'string') {
    throw invalidParams(`${label} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw invalidParams(`${label} must be ${min}-${max} characters.`);
  }
  // Disallow control characters that could be used for spoofing in approval UI.
  // eslint-disable-next-line no-control-regex -- intentionally rejects control characters
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
    throw invalidParams(`${label} contains unsupported characters.`);
  }
  return trimmed;
}

export function isValidHttpOrigin(origin) {
  if (typeof origin !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === origin;
  } catch {
    return false;
  }
}

export function requireParamsArray(params, { min = 0, max = 16 } = {}) {
  const value = params === undefined ? [] : params;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw invalidParams('Expected params to be an array.');
  }
  return value;
}
