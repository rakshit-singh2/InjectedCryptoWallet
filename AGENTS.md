# Project Guide for Coding Agents

Read this file before changing code. The security and testing rules apply to all changes. The architecture map describes the current repository; keep it updated when responsibilities or paths change.

## Project at a Glance

This is a React 18 + Vite Manifest V3 browser-extension wallet for EVM chains. The extension injects an EIP-1193 provider (also announced via EIP-6963) and a background service worker owns the vault, keys, permissions, networks and approvals. dApp connection, `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, chain switching/adding and `wallet_watchAsset` are implemented behind explicit user approval. It is not audited and must not be represented as safe for real funds.

## Structure

```text
.
├── index.html                         # Vite popup entry document
├── public/
│   ├── manifest.json                  # MV3 manifest (storage + alarms only; MAIN-world provider script)
│   ├── logo.svg, icons/               # Rakshit Wallet "R" mark (source SVG) and rendered PNG extension icons
│   └── svg/                           # Token/network artwork
├── src/
│   ├── background/                    # Service worker = the wallet's trust anchor
│   │   ├── index.js                   # chrome.* listeners: provider port, popup messages, alarms, windows
│   │   ├── wallet.js                  # Wires controllers together (unit-testable without chrome events)
│   │   ├── controllers/
│   │   │   ├── VaultController.js     # Encrypted vault, unlock/lock, session key, auto-lock, accounts, signers
│   │   │   ├── NetworkController.js   # Networks, selected chain, RPC validation and JSON-RPC forwarding
│   │   │   ├── PermissionController.js# Per-origin eth_accounts permissions (EIP-2255 shaped)
│   │   │   ├── ApprovalController.js  # Approval queue + single approval window
│   │   │   ├── TransactionController.js # Tx validation, gas/EIP-1559 fees, calldata decoding, sign + broadcast
│   │   │   └── BatchController.js     # EIP-5792 batches: sequential (never atomic), per-origin ids, stop on failure / user stop
│   │   ├── rpc/
│   │   │   ├── providerMethods.js     # dApp method policy (allow-list, signing incl. typed data v3/v4, chain, permissions, EIP-5792)
│   │   │   └── popupMethods.js        # Extension-page API (onboarding, accounts, networks, approvals, send)
│   │   ├── legacyMigration.js         # One-time import of the v1 popup-owned storage layout
│   │   ├── rateLimit.js               # Per-origin token bucket for provider requests
│   │   ├── vaultCrypto.js             # PBKDF2-SHA256 (600k) + AES-GCM vault records
│   │   ├── store.js                   # chrome.storage.local/session wrappers and keys
│   │   ├── validation.js              # Chain ID, address, URL, text and params validation
│   │   └── errors.js                  # EIP-1193/1474 error codes; safe error serialisation
│   ├── contentscript/
│   │   ├── provider.js                # MAIN-world EIP-1193 provider + EIP-6963 announcement (no secrets)
│   │   └── content.js                 # Isolated-world relay to the background over a runtime port
│   ├── shared/
│   │   ├── networks.js                # Built-in networks with hard-coded chain IDs
│   │   └── assetStore.js              # IndexedDB tokens/NFTs/history (no secrets); v1 schema upgrade
│   ├── helpers/
│   │   ├── walletApi.js               # Popup client for popupMethods (the only way the UI touches the wallet)
│   │   ├── legacyVault.js             # Reads/clears the v1 localStorage vault during migration
│   │   └── rpc.js                     # Read-only provider + formatting helpers for the popup
│   ├── components/                    # Popup UI (onboarding, unlock, wallet, accounts, networks, approvals)
│   ├── App.jsx, main.jsx              # Popup state machine (onboarding / locked / unlocked / #/approval)
│   ├── theme.js, index.css, App.css   # Brand tokens (green primary, orange accent) → antd ConfigProvider + CSS variables
│   └── ABI/                           # Contract ABIs
├── contracts/                         # Vendored third-party contracts (read-only; see contracts/README.md). Not used by the wallet yet
│   └── metamask-delegation-framework/ # MetaMask Delegation Framework v1.3.0 (MIT/Apache-2.0), unmodified
├── tests/
│   ├── unit/                          # Vitest: controllers, provider policy, migration, build output
│   └── e2e/                           # Playwright: built extension in Chromium with a local fake RPC node
├── vite.config.js                     # Popup, background and content-script entries; Vitest config
├── playwright.config.js               # Browser matrix for extension e2e tests
├── plan.md                            # Staged injected-wallet implementation plan and status
├── THREAT_MODEL.md                    # Assets, actors, controls and residual risks; update with security changes
├── .eslintrc.cjs                      # Lint rules incl. no DOM/web storage in the service worker
└── CLAUDE.md                          # Claude Code entrypoint; defers to this guide
```

## Architecture and Trust Boundaries

- **Web page / dApp:** untrusted. It may request wallet operations but must never receive a seed phrase, password, or private key.
- **`contentscript/provider.js` (MAIN world):** page-context provider only. No extension APIs, storage, approval decisions or secrets. The page can tamper with it freely, so nothing it reports is trusted.
- **`contentscript/content.js` (isolated world):** validates message shape/size and relays over a `chrome.runtime` port. It never asserts an origin; the background reads it from `port.sender`.
- **Background service worker:** the only place secrets are decrypted and the only authorization boundary. Derives origin from browser sender metadata (top frame only), applies the method allow-list and permission policy, requires an approval for every connection, signature, transaction, chain switch/add and watched asset, and fails closed (lock, window close, timeout, worker restart, chain change during review).
- **Extension pages (popup, approval window):** authenticated by `sender.url` starting with the extension's own URL. UI state is not an authorization boundary; the background re-validates every decision (e.g. connect may only grant the wallet's own accounts; approve requires unlocked).
- **Storage:** `chrome.storage.local` holds the AES-GCM vault and public metadata; `chrome.storage.session` (trusted contexts only, memory-only) holds the derived vault key while unlocked so the wallet survives worker suspension. IndexedDB holds only non-secret asset data. Client-side encryption does not protect secrets from malicious code running inside the extension while it is unlocked.

Signing is enabled only through the approval flows above. Any new signing or state-changing method must go through `ApprovalController`, validate its inputs in the background, and come with unit tests covering rejection and malformed input.

## Change Rules

1. Inspect relevant callers, storage behavior, manifest/build output, and tests before editing. Preserve existing user data; never clear or rewrite wallet storage as a shortcut.
2. Treat every request from a dApp as untrusted. Validate schemas, supported methods, request size, origin, account ownership, chain, and permission state in the background. Reject unsupported or ambiguous requests.
3. Never log or return passwords, seed phrases, private keys, decrypted vault records, or signed transaction payloads.
4. Do not put secrets in Vite `VITE_*` variables, local/session storage in plaintext, page globals, URLs, or DOM attributes.
5. Keep browser/provider APIs behind the extension boundary. UI components should call narrow helpers rather than implementing crypto or signing policy.
6. Update this guide and `plan.md` when the extension architecture or implementation status changes. Update user-facing documentation for behavior changes.
7. Do not use mocks or successful fallbacks that make security-sensitive flows appear to work. Surface failures and fail closed.

## Interactive Element Test IDs

Every interactive UI element must have a stable, unique `data-testid` attribute. This applies to every existing element when touched and every new element, including:

- buttons, links, tabs, menus, dropdowns, checkboxes, switches, radio controls and clickable cards/icons;
- text/password/number inputs, textareas, search fields and custom comboboxes;
- modal/dialog actions, transaction approval/rejection controls, account/network selectors and pagination controls;
- custom elements with keyboard or pointer interaction.

Use descriptive kebab-case IDs, for example `data-testid="connect-approve-button"`, `data-testid="wallet-password-input"`, and `data-testid="network-selector"`. For repeated items, make IDs stable and item-specific (for example `account-row-${address}`); never use array indices if a stable domain identifier is available. Do not add test IDs to non-interactive text solely for convenience.

Tests should select controls with Playwright's `getByTestId(...)` and assert visible state/results. Keep controls accessible with labels, roles, keyboard support and focus behavior; a test ID supplements accessibility and does not replace it.

## Build, Tests, and Browser Validation

- Install dependencies only when needed: `npm install`
- Production build: `npm run build`
- Unit tests: `npm test` (Vitest). `npm run verify` builds first so the build-output checks also run.
- Extension e2e: `npm run test:e2e` (builds, then Playwright). Set `CHROMIUM_PATH` to reuse an already-installed Chromium, or run `npx playwright install chromium` with user approval. `BRAVE_PATH` adds a Brave project.
- Lint: `npm run lint` (must pass with zero warnings). Escapes like `\u202e` must stay escaped in source; the source-hygiene test rejects literal bidi/invisible characters.

For every UI or injected-provider change, use Playwright MCP/browser automation and attempt the full requested browser matrix: Safari, Google Chrome, Brave and Microsoft Edge. Include test IDs in UI work and exercise the changed flow plus regression paths. If MCP cannot launch one of the targets, fall back to a locally available Playwright setup where possible and record the exact blocker; do not silently skip a browser. The browser-specific constraints are:

| Target | Playwright approach | Important limitation |
|---|---|---|
| Google Chrome | Chromium browser with the `chrome` channel, when installed | Branded Chrome 137+ ignores `--load-extension`; the e2e fixture skips with that reason. Validate by loading `dist/` manually via chrome://extensions |
| Microsoft Edge | Chromium browser with the `msedge` channel, when installed | Validated 2026-11-07 (Edge 157): e2e passes |
| Brave | Chromium browser with Brave's installed executable path, when available | Brave is not a standard Playwright channel; set `BRAVE_PATH`. Validated 2026-11-07 (Brave 157) |
| Safari | Playwright WebKit for web/provider behavior | WebKit is not the Safari application. Safari Web Extension packaging/install/permissions require real Safari/macOS validation and cannot be claimed from WebKit alone |

Playwright extension support depends on the selected browser/channel and launch mode; some Chromium extension tests require a persistent context and a locally built unpacked extension. First discover which MCP tools and browser binaries are actually available. Run each feasible target, report exact browser/version and results, and explicitly mark unavailable targets as not tested. Never silently substitute Chromium for Safari or claim WebKit proves Safari-extension compatibility. Do not install browsers or change system configuration without a task need and user authorization.

Before completion, run the smallest relevant checks and at least `npm run build` for changes to app or extension sources. Report failures and environmental gaps accurately.
