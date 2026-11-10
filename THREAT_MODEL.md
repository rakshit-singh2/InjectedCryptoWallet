# Threat Model — Rakshit Wallet

Scope: the MV3 extension in this repository (v1.1.x). Companion to the trust boundaries in [`AGENTS.md`](./AGENTS.md). This is an engineering threat model, not an audit.

## Assets

| Asset | Where it lives | Impact if lost |
|---|---|---|
| Recovery phrase, imported private keys | Encrypted in `chrome.storage.local` (`vault`); decrypted only in service-worker memory | Total loss of funds |
| Vault encryption key | `chrome.storage.session` while unlocked (memory-only, trusted contexts) | Equivalent to keys while the browser runs |
| Password | Never stored; passed once per unlock/export | Offline brute force of the vault |
| Signing authority | Background `getSigner` behind approvals | Unauthorised signatures / transactions |
| Account ↔ site linkage | `approvedOrigins` permissions | Privacy: cross-site tracking of addresses |
| Network integrity | `networks`, `selectedChainId` | Wrong-chain signing, fake balances |

## Actors

1. **Malicious or compromised website** (primary threat). Fully controls the page, including the injected provider object.
2. **Malicious RPC endpoint**, either added by the user or a built-in one gone bad. Can lie about state and see addresses and IPs.
3. **Network attacker.** Mitigated by HTTPS-only RPCs (except loopback).
4. **Local attacker with brief device access** (walk-up).
5. **Compromised dependency or extension update** (supply chain). Out of the runtime model's control; see residual risk.
6. **Other extensions.** Cannot message this extension: there is no `externally_connectable`, and the sender id is checked.

## Trust boundaries and controls

| Boundary | Threat | Control | Tests |
|---|---|---|---|
| Page → provider (MAIN world) | Page tampers with provider or forges relay messages | Provider holds no state the background trusts; the relay only forwards method and params | e2e injection tests |
| Relay → background | Origin spoofing | Origin derived from `port.sender` (top frame, http(s) only); page-supplied origins ignored | unit: provider policy; code: `background/index.js` |
| Relay → background | Flooding / DoS | Payload ≤ 512 KB; ≤ 50 in flight per port; per-origin token bucket (200 burst, 50/s); approval queue limits (20 total, 5 per origin) | unit: rate limiting, -32002 |
| Background method policy | Unapproved access / signing | Allow-list; every account, sign, tx, chain or asset action requires approval; `eth_sign` refused; `from` must be permitted for the origin | unit: 4100 / 4200 / 4001 paths |
| Approval UI | Display ≠ signed payload | UI only shows background-held params; the decision is approve/reject only; the tx proposal is frozen; nonce assigned at signing; refusal if the chain changed | unit + e2e: signed tx matches display |
| Approval UI | Spoofed names / text | Control and bidi characters rejected in names; origin shown prominently; plain-http origins tagged "Not secure"; non-text personal_sign warned; unlimited approvals flagged | unit: `normalizeText`, calldata decoding |
| Approval lifecycle | Stale or orphaned approval | Reject on window close, lock, timeout, worker restart (port drop → 4900; orphans discarded); race-free window release | unit + e2e (incl. worker kill) |
| Extension pages → background | Page impersonating the popup | Popup API accepted only when `sender.url` starts with the extension's own URL | code: `isExtensionPage` |
| Vault at rest | Offline brute force / tamper | PBKDF2-SHA256 600k + AES-GCM-256; tamper detection; metadata cross-checked against secrets | unit: tamper, inconsistency |
| Unlock | Online guessing | Exponential lockout after 5 failures (persisted) | unit: throttling |
| Unlocked session | Walk-up access | Auto-lock (1 min – 4 h, default 15 min); key export re-asks for the password and auto-hides after 60 s | unit: preferences, export |
| Networks | Wrong chain / malicious RPC | Hard-coded built-in chain IDs; custom RPC must report its declared chain ID; https only (except loopback), no credentials, no redirects, response ≤ 8 MB, 30 s timeout; typed-data domain chain must match | unit: validation, network |
| Storage | Secrets in web storage | Service worker cannot reach `localStorage`/DOM (ESLint `no-restricted-globals`); tests assert no mnemonic/password in storage | unit + e2e |
| Source | Trojan-Source / hidden characters | Test fails on bidi or invisible characters in source | unit: source hygiene |
| Session | Lock racing a session restore | Lock generation counter discards stale restores | unit: securityReview M1 |
| Auto-lock | Site keeps the wallet awake via an open prompt | Polling methods don't reset the timer; only user input does | unit: securityReview M2 |
| Batched calls (EIP-5792) | User approves a batch believing it is atomic; a later call signs an unseen fee; batch keeps running after lock, revoke or chain change; cross-site status leaks | Non-atomic declared in the capabilities and the approval UI; deferred-fee calls get their own approval; checks before every call (lock, permission, chain, cancel) plus `signAndSend`'s chain check; ids scoped per origin; restarted worker never resumes | unit: `batch.test.js` (mutation-checked); e2e |
| Approval UI | Click lands on a request that just slid into place | Approve disabled for 1 s whenever the head request changes | manual / code |

## Review history

- 2026-11-07, independent review (separate reviewer, code only): 0 critical, 0 high, 2 medium, 7 low. All fixed with regression tests; see `plan.md` Phase 6.
- 2026-11-07, independent review of EIP-5792 batches and typed-data v3: 0 critical, 0 high, 3 medium, 4 low, all fixed with regression tests (nonce lock, hash recorded before broadcast, no receipts in session storage, one batch prompt per site, stale-fee re-approval, status hidden while locked); see `plan.md` Phase 7.

## Residual risks (accepted or open)

- **Code running inside the extension** (a malicious dependency or compromised build) can read keys while unlocked. Mitigations: minimal dependencies, a lockfile, the `npm audit` gate, and in future reproducible builds and signed releases.
- **Approvals rely on the user reading them.** There is no transaction simulation or phishing list yet, and contract calls beyond ERC-20 approve/transfer and `setApprovalForAll` are shown only as a selector and length.
- **Partial batches.** A non-atomic batch can leave earlier calls on chain when a later one fails (for example an approval without the swap). The approval screen warns about this, and dApps learn of it from status 600.
- **Approval-queue flooding from many subdomains** can still fill the global queue (20) for up to 10 minutes. The user can reject all from a site; per-registrable-domain caps would need a public-suffix list.
- **Read pass-through needs no connection** (same as MetaMask). Any site can make the user's RPC provider see requests from the user's IP. Rate-limited, not prevented.
- **Approval resolvers live in worker memory.** A worker restart cancels pending prompts, and the dApp must retry. This fails closed but hurts UX.
- **Imported keys are unrecoverable without the password.** A seed-phrase reset removes them, after explicit confirmation.
- **Safari is not validated yet.** Google Chrome can't be automated: unpacked extensions must be loaded manually. Chromium, Edge and Brave pass the e2e suite.

## Out of scope

Hardware wallets, multisig, account abstraction, mobile, and phishing-domain blocklists. These are feature work, not mitigations of current threats.
