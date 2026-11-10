# Contracts

Third-party smart contracts kept for reference and review. **Nothing here is compiled, deployed or called by Rakshit Wallet yet.** EIP-7702 support is not built; see `plan.md`, Phase 7.

## `metamask-delegation-framework/`

An unmodified copy of MetaMask's Delegation Framework.

| | |
|---|---|
| Source | https://github.com/MetaMask/delegation-framework |
| Release | `v1.3.0` (MetaMask tags audited releases) |
| Commit | `bfbdf9795a976833ed2fa000baf42fbb83958b03` |
| Copied | 2026-11-07 |
| Licence | Dual MIT / Apache-2.0: see `LICENSE-MIT.md` and `LICENSE-APACHE2.md`. Keep both files and the copyright notices. |

**Included:** `src/` (contracts), `test/`, `script/`, `documents/`, `audits/` (Cyfrin and Consensys Diligence reports), `foundry.toml`, `remappings.txt`, `README.md`, `CONTRIBUTING.md` and `.gitmodules`.

**Left out:**
- `broadcast/` (18 MB of deployment run logs)
- `lcov.info` (coverage output)
- `lib/` (third-party git submodules: OpenZeppelin, forge-std, account-abstraction and others, listed in `.gitmodules`)

**Rules for this folder:**
- Do not edit files here. To update, copy a newer audited tag over the whole folder, then update this README.
- Check `src/` against upstream with:
  ```sh
  git clone --depth 1 --branch v1.3.0 https://github.com/MetaMask/delegation-framework /tmp/df
  diff -r /tmp/df/src contracts/metamask-delegation-framework/src
  ```

**To build or test** (needs [Foundry](https://getfoundry.sh); not installed on the dev machine):
```sh
git clone --branch v1.3.0 --recurse-submodules https://github.com/MetaMask/delegation-framework
cd delegation-framework && forge build && forge test
```

### Deployed addresses (v1.3.0)

Source: `metamask-delegation-framework/documents/Deployments.md`. The contracts are deployed with CREATE2 using salt `"GATOR"`, so each one has the same address on every supported chain. That file lists all 37 v1.3.0 contracts; the ones relevant to the wallet are:

| Contract | Address | Role |
|---|---|---|
| `EIP7702StatelessDeleGatorImpl` | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` | The account code an EOA would delegate to with EIP-7702. It runs batched calls (ERC-7579 `execute`) when the EOA's own key authorises them. |
| `DelegationManager` | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | Validates and redeems delegations (permissions granted to other parties). |
| `SimpleFactory` | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` | CREATE2 deployer. |
| `HybridDeleGatorImpl` | `0x48dBe696A4D990079e039489bA2053B36E8FFEC4` | Smart-account implementation (EOA + passkey signers); not for 7702. |
| `MultiSigDeleGatorImpl` | `0x56a9EdB16a0105eb5a4C54f4C062e2868844f3A7` | Multisig smart-account implementation; not for 7702. |

### On-chain check (2026-11-07)

`eth_getCode` found deployed code at both key addresses on every network the wallet ships with:

| Network | `EIP7702StatelessDeleGatorImpl` | `DelegationManager` |
|---|---|---|
| Ethereum (0x1) | 11,185 bytes | 11,503 bytes |
| Sepolia (0xaa36a7) | 11,185 bytes | 11,503 bytes |
| Polygon (0x89) | 11,185 bytes | 11,503 bytes |
| Polygon Amoy (0x13882) | 11,185 bytes | 11,503 bytes |

The code is the same size on every chain, but its hash differs by chain. That is expected: these contracts store chain-specific values at deployment (for example their EIP-712 domain separator, which includes the chain ID). Finding code at an address does **not** prove it was built from this source.

Before the wallet ever delegates an account, it must verify each chain's deployed code against bytecode compiled from this tag, with the chain-specific values accounted for, and pin the expected code hashes per chain in the wallet.
