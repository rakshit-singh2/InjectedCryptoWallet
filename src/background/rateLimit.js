/**
 * Per-key token bucket. Protects the user's RPC provider (and their IP/quota) from a page that
 * floods the wallet with requests, and keeps one site from starving others.
 */
export class RateLimiter {
  constructor({ capacity = 200, refillPerSecond = 50, maxKeys = 1000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  /** Returns true if the call may proceed and consumes one token. */
  take(key) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        // Drop the oldest entry; Map preserves insertion order.
        this.buckets.delete(this.buckets.keys().next().value);
      }
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updated) * this.refillPerMs);
    bucket.updated = now;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }
}
