# Rakshit Wallet

A Manifest V3 browser-extension wallet for EVM chains, in the style of MetaMask. Brand: green (`#0f8a4f`) and orange (`#f2621a`) with the "R" mark in `public/logo.svg` (PNG icons in `public/icons/`; theme tokens in `src/theme.js`). See [`plan.md`](./plan.md) for the roadmap and status and [`AGENTS.md`](./AGENTS.md) for project structure, security boundaries, required UI test IDs and browser-testing instructions. Claude Code should also follow [`CLAUDE.md`](./CLAUDE.md).

> **Prototype — not audited. Do not use with real funds.**

## What it does

- Injects an EIP-1193 provider into http(s) pages at `document_start` and announces it via **EIP-6963**, so it works alongside other wallets. `window.ethereum` is set only when no other wallet has claimed it.
- Supported dApp methods: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `net_version`, `personal_sign`, `eth_signTypedData_v4` and `_v3`, `eth_sendTransaction`, EIP-5792 `wallet_sendCalls` / `wallet_getCallsStatus` / `wallet_getCapabilities` (sequential, not atomic), `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_watchAsset` (ERC-20), `wallet_requestPermissions` / `wallet_getPermissions` / `wallet_revokePermissions`, plus an allow-list of read-only RPC methods (`eth_call`, `eth_getBalance`, `eth_estimateGas`, `eth_getLogs`, receipts, blocks, …) forwarded to the selected network. `eth_sign`, legacy typed data v1, sign-only `eth_signTransaction` and other risky or unsupported methods are refused.
- Every connection, signature, transaction, chain switch/add and watched token is shown in an extension-owned approval window with the requesting origin. Transactions show the network, recipient, value, gas and maximum cost, and warn on unlimited ERC-20 approvals and `setApprovalForAll`.
- Keys never leave the background service worker. The vault is encrypted with AES-GCM (PBKDF2-SHA256, 600k iterations). While unlocked, only the derived key is cached in memory-only session storage. The wallet auto-locks after 15 minutes of inactivity.
- Configurable auto-lock (Settings), per-site rate limiting, and "reject all from this site" for prompt floods.
- HD accounts from a BIP-39 phrase, imported private keys, custom networks (validated against the RPC's reported chain ID), connected-site management, token/NFT tracking and transaction history.

## Upgrading from 1.0

On first open after updating, the popup asks for your existing password once. It then moves the accounts from the old popup storage into the background vault, keeping names, networks and the selected chain. The old encrypted records are kept as a backup inside extension storage, and the old plaintext and verifier fields are removed. If the password is wrong, nothing changes.

## Development

```sh
npm install
npm run build          # emits the extension into dist/
npm run lint           # ESLint (zero warnings)
npm test               # unit tests (Vitest)
npm run verify         # build + unit tests, including build-output checks
npm run test:e2e       # build + Playwright extension tests (needs a Playwright Chromium;
                       # set CHROMIUM_PATH to reuse one you already have)
```

Load `dist/` as an unpacked extension from `chrome://extensions` (Developer mode → Load unpacked) in Chrome, Edge or Brave 111+. `npm run dev` serves the popup UI only; wallet features need the installed extension.

## Known limitations

- Not audited. Malicious code running inside the extension (for example a compromised dependency) can read secrets while the wallet is unlocked.
- Batched calls (EIP-5792) are not atomic: each call is sent after the previous one succeeds and the batch stops at the first failure, but calls already confirmed stay on chain. A call whose fee can only be estimated after an earlier call confirms gets its own confirmation. Running batches appear in the wallet popup with a **Stop batch** button. If the browser stops the service worker mid-batch, the unsent calls are dropped, never resumed.
- Pending approvals live in the service worker. If the browser kills the worker mid-approval, the request fails closed and the dApp must retry.
- Imported private-key accounts are not recoverable from the recovery phrase; resetting the password with the phrase removes them, after an explicit confirmation.
- Tested automatically in Chromium, Microsoft Edge and Brave. Google Chrome needs a manual load. Safari has not been validated yet (see `plan.md`, Phase 6).
- See [`THREAT_MODEL.md`](./THREAT_MODEL.md) for the security model and residual risks.
"# InjectedCryptoWallet" 
