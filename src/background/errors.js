// EIP-1193 / EIP-1474 error codes used across the background.
export const ErrorCodes = Object.freeze({
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  unrecognizedChain: 4902,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resourceUnavailable: -32002,
  limitExceeded: -32005,
  // EIP-5792 (wallet_sendCalls)
  unsupportedCapability: 5700,
  unsupportedChainId: 5710,
  duplicateBundleId: 5720,
  unknownBundleId: 5730,
  bundleTooLarge: 5740,
  atomicityUnsupported: 5760,
});

export class WalletError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export const rejected = (message = 'The user rejected the request.') =>
  new WalletError(ErrorCodes.userRejected, message);

export const unauthorized = (message = 'The requested account or method has not been authorized by the user.') =>
  new WalletError(ErrorCodes.unauthorized, message);

export const invalidParams = (message) => new WalletError(ErrorCodes.invalidParams, message);

export const unsupported = (message) => new WalletError(ErrorCodes.unsupportedMethod, message);

/**
 * Converts any thrown value into a plain serialisable error that is safe to return
 * to a page. Internal error details are never forwarded; only WalletError messages are.
 */
export function toSerializableError(error) {
  if (error instanceof WalletError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  return { code: ErrorCodes.internal, message: 'Internal wallet error.' };
}
