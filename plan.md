# Injected Wallet Implementation Plan

## Goal and Safety Bar

Deliver an EIP-1193-compatible injected EVM wallet backed by the browser extension. dApps may request public account access and approved wallet operations; seed phrases, passwords and private keys never cross into page context. This is a staged plan, not a claim that the prototype is audited or safe for real funds.

**Current baseline (v1.1.0, 2026-11-07):** the background service worker owns an AES-GCM/PBKDF2 vault, HD and imported keys, networks, per-origin permissions and a single approval window. A MAIN-world provider (EIP-1193 + EIP-6963) talks to it through an isolated-world relay port. Connection, `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_watchAsset` and EIP-2255 permission methods work behind explicit approval. Phase 7 adds `eth_signTypedData_v3` and non-atomic EIP-5792 batches. v1 wallets (popup localStorage/IndexedDB) migrate on first unlock. 74 unit tests pass, and the 4 extension e2e tests pass in Chromium, Microsoft Edge and Brave; lint clean; 0 production audit findings.

## Phase 0 — Build and Baseline ✅

- [x] Clean production build; content scripts verified dependency-free by `tests/unit/buildOutput.test.js`.
- [x] Vitest unit runner (`npm test`, `npm run verify`) and Playwright extension e2e (`npm run test:e2e`).
- [x] Stable `data-testid` on every interactive element touched.
- [x] Removed unused/duplicate dependencies (`web3`, `@ethersproject/providers`, `react-scripts`, `crypto-js`, `axios`, `dotenv`, …); popup bundle 1.65 MB → 1.05 MB.
- [x] Removed the hard-coded Infura key; built-in networks have hard-coded chain IDs and key-less public RPCs.
- [x] Manifest: `storage` + `alarms` only (dropped the invalid `windows` permission and `web_accessible_resources`).
- [x] Source backup taken before the refactor (`../UninjectedCryptoWallet-main.backup-2026-11-07.tar.gz`).

## Phase 1 — Background Vault and Keyring ✅

- [x] `VaultController` in the service worker: PBKDF2-SHA256 600k + AES-GCM vault in `chrome.storage.local`, versioned record.
- [x] Unlock caches only the derived AES key in `chrome.storage.session` (trusted contexts, memory-only) so the wallet survives worker suspension; lock clears it.
- [x] Auto-lock via `chrome.alarms` (15 min of inactivity; popup activity pings reset it). Exponential unlock throttling after 5 failures.
- [x] HD (`m/44'/60'/0'/0/i`) and imported accounts; account metadata verified against decrypted secrets on unlock.
- [x] Private-key export requires the password again. The popup never stores the password or mnemonic.
- [x] Idempotent v1 → v2 migration: verifies the password against the legacy record, classifies HD vs imported accounts, carries over names/networks/last chain, keeps an encrypted backup, then strips legacy keys. Covered by `tests/unit/migration.test.js`.
- [x] Seed-phrase password reset; imported accounts that can't be recovered require explicit confirmation and are listed.

## Phase 2 — Provider and Relay ✅

- [x] Provider injected in the MAIN world at `document_start` (no async `<script>` race); relay handshake queues early requests.
- [x] EIP-6963 announce/request; `window.ethereum` set only if absent (coexists with other wallets).
- [x] `connect` / `disconnect` / `accountsChanged` / `chainChanged` semantics; legacy `enable`, `send`, `sendAsync`.
- [x] Runtime port relay with keep-alive while requests are pending; port loss fails pending requests with 4900.
- [x] State changes broadcast as data-free pings; each tab re-queries for its own origin (no cross-origin account leakage, no tab tracking).
- [ ] Full EIP-1193 conformance review against popular dApp libraries (wagmi/viem, web3modal, ethers BrowserProvider).
- Decision: MessageChannel between provider and relay was dropped — the page fully controls the provider object anyway; the trust boundary is relay → background, which uses browser sender metadata.

## Phase 3 — Networks and Read-Only Methods ✅

- [x] `NetworkController` is the single source of truth for the selected chain.
- [x] Explicit read allow-list forwarded to the selected RPC; everything else returns 4200. `eth_sign` refused.
- [x] `wallet_switchEthereumChain` (4902 for unknown chains) and `wallet_addEthereumChain` (RPC must report the declared chain ID; user approval; add-and-switch).
- [x] RPC URL rules: https only (http for loopback), no credentials or fragments, no redirects, response size and timeout limits.

## Phase 4 — Approvals and Permissions ✅

- [x] Single approval window with a queue; duplicate connect/chain prompts per origin return -32002; per-origin and global limits.
- [x] Closing the window, locking, timeout (10 min) or worker restart rejects with 4001; orphaned prompts are discarded on worker start.
- [x] Race-free window reuse: an empty window asks the background before closing (`releaseApprovalWindow`).
- [x] Account picker on connect; locked wallet unlocks inside the approval window.
- [x] `wallet_requestPermissions`, `wallet_getPermissions`, `wallet_revokePermissions`; Connected Sites screen.

## Phase 5 — Signing ✅

- [x] `personal_sign` with text/hex preview and non-text warning.
- [x] `eth_signTypedData_v4` with type validation and domain chain check.
- [x] `eth_sendTransaction`: schema validation, chainId match, permitted `from`, EIP-1559 (or legacy) fees, gas estimate with headroom for contract calls, decoded ERC-20 approve/transfer and `setApprovalForAll` warnings, immutable proposal, nonce at signing time, refusal if the network changed during review, node hash verified.
- [x] Popup Send uses the same background path with a review step.

## Phase 6 — Validation and Hardening (in progress)

Done (2026-11-07):

- [x] Activity history written by the background; `wallet_watchAsset` (ERC-20).
- [x] **Independent security review** by a separate reviewer: no critical or high findings. All 9 findings fixed, each with a regression test in `tests/unit/securityReview.test.js`; the tests for the two medium findings and the RPC streaming cap were checked to fail when their fix is reverted:
  - M1: lock during a session restore could leave the wallet unlocked → lock generation counter.
  - M2: approval-window polling defeated auto-lock → only user actions reset the timer; the popup pings only on real input.
  - L3: typed-data approvals displayed unsigned extra fields → only declared fields are shown and signed, and extras are flagged.
  - L4: approval-queue flooding → "Reject all from this site".
  - L5: legacy backup kept forever → deleted on seed reset and after 30 days.
  - L6: legacy key strip not retried → retried on startup and on re-migration.
  - L7: a new request could slide under the cursor → approve is disabled for 1 s when the request changes.
  - L8: `wallet_getPermissions` leaked accounts while locked → returns `[]`.
  - L9: RPC body read before the size check → byte-capped streaming read.
- [x] [`THREAT_MODEL.md`](./THREAT_MODEL.md): assets, actors, boundaries, controls mapped to tests, residual risks.
- [x] ESLint config with wallet guard-rails: no `eval`/`dangerouslySetInnerHTML`, and no `window`/`localStorage`/DOM in the service worker. `npm run lint` passes with zero warnings.
- [x] Source-hygiene test: fails on bidi or invisible characters (Trojan Source). It found and fixed real ones in `validation.js`.
- [x] `react-router` upgraded to v7: `npm audit --omit=dev` reports 0 vulnerabilities.
- [x] Per-origin rate limiting of provider requests (token bucket: 200 burst, 50/s).
- [x] Auto-lock setting UI (1 min – 4 h).
- [x] Automated test for service-worker termination mid-approval (CDP `ServiceWorker.stopAllWorkers`): fails closed with 4900, the orphaned prompt is discarded, and the session survives.
- [x] Chromium (Chrome for Testing 153) e2e: 4/4 tests, stable across repeated runs.

Open:

- [ ] **Google Chrome 157:** automated extension loading is blocked (137+ ignores `--load-extension`; the workarounds disable a Chrome security feature and were not used). Manual check: chrome://extensions → Developer mode → Load unpacked → `dist/`, then run the e2e flow by hand against any dApp.
- [x] **Microsoft Edge 157 and Brave 157** (installed via Homebrew on 2026-11-07): 4/4 e2e tests each, stable across 2 runs. Command: `BRAVE_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npx playwright test --project=msedge --project=brave`. Both still honour `--load-extension`, unlike Google Chrome 137+.
- [ ] **Safari:** requires full Xcode (only Command Line Tools are installed). Steps: `xcrun safari-web-extension-converter dist --app-name "Rakshit Wallet"`, build and run, enable it in Safari → Settings → Extensions (allow unsigned extensions in Develop menu), then confirm `content_scripts[].world: "MAIN"`, `chrome.storage.session` and `windows.create({type:'popup'})` behave.
- [ ] Hardware wallets, transaction simulation, phishing-domain list (product decisions; they need external services or data sources).
- [ ] External professional audit before any real-funds claim.

## Phase 7 — Wider dApp Compatibility (2026-11-07)

- [x] `eth_signTypedData_v3`: shares the v4 validation path (domain chain check, only signed fields shown) and rejects arrays, which v3 cannot encode; without arrays the v3 and v4 digests are identical. v1 and the unversioned method stay refused: they have no domain separator, so signatures are not bound to an app or chain.
- [x] EIP-5792 v2.0.0 (`wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus`) in `BatchController`, **non-atomic only**: capabilities report `atomic: unsupported` and `atomicRequired: true` returns 5760. One approval lists every call (decoded, total value, max fees). Calls run sequentially, each after the previous one is mined successfully; the batch stops at the first revert, rejection, lock, revoked connection or network change. A call that can't be estimated before earlier calls confirm (approve → swap) gets its own confirmation with exact fees. Bundle ids are scoped per origin and kept in session storage; a restarted worker never resumes unsent calls. Max 10 calls per batch and one running batch per site.
- [x] Independent security review of Phase 7: no critical or high findings. Fixed, each with a regression test:
  - M1: concurrent sends from one account could reuse a nonce → per-account signing lock plus memory of the last nonce used (60 s), because load-balanced RPCs may lag.
  - M2: a crash between broadcast and saving could report a sent transaction as "not sent" (400) → the hash is saved before broadcasting and dropped only if the node explicitly refuses the transaction. This also fixed an occasionally failing test.
  - M3: receipt logs in session storage could exhaust its quota → only hashes and per-hash results are stored, receipts are fetched live and must match the hash, and a batch record is rolled back if saving fails.
  - L1/L4: one pending batch prompt per site, refused before any gas estimation.
  - L2: pre-approved fees older than 3 minutes are re-estimated and confirmed again.
  - L3: batch status is hidden while locked and forgotten when the site is disconnected.
- [x] **Stop batch:** the wallet popup lists running batches (`RunningBatches.jsx`) with a "Stop batch" button. Stopping signs nothing further, rejects a pending step prompt and stops waiting; already-sent transactions still count in the status (unit + e2e in all three browsers).
- [ ] Review notes not acted on: a step rejected after earlier successes reports 600 like a partial revert (wagmi/viem treat it as failure); v4/v3 ignore a declared `EIP712Domain` that differs from the domain object (pre-existing, signature just won't verify).
- [x] Tests: `tests/unit/batch.test.js` (19). The stop checks were mutation-tested: disabling them makes the revoked-connection and restart tests fail. e2e covers v3 signing and a two-call batch in Chromium, Edge and Brave.
- [x] Reference copy of MetaMask Delegation Framework v1.3.0 in `contracts/` (licences, audits, provenance); `EIP7702StatelessDeleGatorImpl` and `DelegationManager` confirmed deployed on Ethereum, Sepolia, Polygon and Amoy.
- [x] Fixed: built-in Polygon/Amoy RPCs had stopped working (`polygon-rpc.com` now requires a key); switched to publicnode, and saved built-in networks now refresh from code on load.
- [ ] Not built on purpose: atomic batches via EIP-7702 (permanently delegates the account to a contract; needs an audited delegate first), `wallet_showCallsStatus`, paymaster and other capabilities.
- [ ] wagmi/viem conformance suite (see Phase 2).

## Required Regression Tests (status)

- [x] Unknown origin gets no accounts; connection approval grants only the selected accounts (unit + e2e).
- [x] `eth_accounts` empty before approval, after revocation and while locked (unit + e2e).
- [x] Origin comes from sender metadata only; foreign accounts cannot be granted (unit; port sender enforced in `background/index.js`).
- [x] Unsupported methods, malformed payloads and oversized requests fail closed (unit).
- [x] Approval UI shows the origin and background-held immutable parameters (e2e asserts origin, message, network and amount).
- [x] Reject, window close, lock and chain change never sign or broadcast (unit + e2e).
- [x] Wrong password, tampered ciphertext, inconsistent metadata, wrong chain and account mismatch cannot sign (unit).
- [x] No mnemonic/password in `chrome.storage`, popup web storage or IndexedDB after onboarding or migration (unit + e2e).
- [x] Service-worker termination mid-approval fails closed and keeps the unlocked session (e2e via CDP).
- [x] Security-review regressions M1–L9 (`tests/unit/securityReview.test.js`).
