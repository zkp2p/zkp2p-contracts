# Deployment support and retirement register

Checked on **22 October 2026**, Base block **52928731** (`0x446f3277eda5c8de8373045dbdce71a70c637d318d8476a20460d2c21368d689`). Source checkout: `f1402703f8f73782203da49cb38a4d74abe40967`.

This register separates supported production, legacy obligations and historical records. A deployment artifact or package export is not proof that an address is active. A source archive is not an on-chain retirement.

## Support policy

- **Supported production/staging:** maintain the selected runtime and its shared dependencies. Environment comes from deployment provenance; Base staging also uses Base mainnet, chain 8453.
- **Retired verification path:** no new use, feature work, redeployment or reactivation. Keep ABI/source/deployment provenance for incident analysis and historical reads. The UPV3 replay-protection cutover is one-way; never restore a retired verifier writer or payment route.
- **Historical review only:** no routine feature work or automatic redeployment. One-time retirement, fund recovery and security obligations remain until the checks below are complete.
- **Funded, connected or unclassified:** do not declare harmless or fully retired. Preserve recovery/support responsibility and track the specific unresolved issue. Do not send new deposits to these addresses.

An address can leave ongoing operational support only after its intended role/provenance is known, protocol assets and liabilities (including stake, claims and pending intents) are zero/resolved, and live references/permissions are removed or proven irrelevant. Check native currency, supported/deposit/stake tokens and a complete asset inventory; allowances, registry writers, callbacks, per-deposit bindings, oracle/rate-manager references and client routing matter too. A failed read is an unresolved check. Preserve immutable deployment lanes and published historical ABIs; this documentation does not delete sources, renounce ownership, withdraw funds or change routing.

## Current production surface

The live settlement path is **EscrowV2 → OrchestratorV3 → UnifiedPaymentVerifierV3**. O3 selects `IntentLifecycleHookV1MethodScopedStaked`; that hook uses `WhitelistPolicyMethodScoped` and `DisputeProtectionPolicyMethodScopedStaked`, which controls `StakeVaultMethodScoped`. Use [`active-dispute-stack.json`](../../deployments/active-dispute-stack.json) for package aliases.

| Component | Base address |
| --- | --- |
| EscrowV2 | `0x777777779d229cdF3110e9de47943791c26300Ef` |
| OrchestratorV3 | `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7` |
| UnifiedPaymentVerifierV3 | `0xC6F4a193576C60892a47e111Bb5706c30162502B` |
| MultiAttestationVerifier | `0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5` |
| IntentLifecycleHookV1MethodScopedStaked | `0x5Dd6C675a7406fE8C9f0D93394a36fd6e8c50031` |
| WhitelistPolicyMethodScoped | `0x389Cd9bA91FfFcd83d267B241E975541892759Ce` |
| DisputeProtectionPolicyMethodScopedStaked | `0xbF4B769dB70DBEc89b6b2c44988304a7aD2de4Fc` |
| StakeVaultMethodScoped | `0x47c26258222e2f96424bD2B21bf173f0DA5034C7` |

Shared registries, the address-group registry, RateManagerV1, DisputeVerifier, IntentGuardian, oracle adapters/FX feeds, current view/per-deposit helpers and their configured dependencies remain supported. In particular, **NullifierRegistryV2 still reads the legacy NullifierRegistry** for replay protection: zero legacy writers does not make that registry disposable.

## Confirmed retired verification paths

| Deployment | Address | Verified reason |
| --- | --- |
| UnifiedPaymentVerifier | `0x16b3e4a3ca36d3a4bca281767f15c7adef4ab163` | All 13 current payment methods route to UPV3; absent from both nullifier writer sets; zero ETH/USDC/USDbC/WETH in this snapshot. |
| UnifiedPaymentVerifierV2 | `0x46a58dc65587d4d7b8198c6a25eedf5b2535da94` | All 13 current payment methods route to UPV3; absent from both nullifier writer sets; zero ETH/USDC/USDbC/WETH in this snapshot. |

This confirms retirement of these verification paths, not an exhaustive all-token or all-external-integrations audit. Do not blanket-retire SimpleAttestationVerifier or other historical dependencies solely because these two callers are retired.

## Legacy connections that still matter

- V1 `Escrow` and `Orchestrator` remain connected: both escrows are whitelisted, and V1 Orchestrator remains in OrchestratorRegistry. V1 funds and intents still require recovery/settlement support.
- Both Across bridge hooks remain whitelisted in the live V1 PostIntentHookRegistry. The first also holds USDC (see below).
- OrchestratorV2 is no longer registered, but this alone does not prove its historical intent records are settled or all legacy callers disconnected. Keep it recovery-only pending reconciliation.
- The OptIn dispute stack is superseded but its stake vault still has accounted USDC. Preserve depositor/claim recovery; do not call it empty.
- The six historical owners listed below remain old-deployer owned with the Safe nominated. Ownership custody and operational retirement are separate decisions.

## Funds prevent blanket retirement

These non-primary entries hold a nonzero audited asset. Current staging balances are included because staging is on Base mainnet and uses real assets. Do not sweep or abandon them without reconciling who owns the money.

| Deployment | Address | USDC | ETH | Other measured balance |
| --- | --- | ---: | ---: | --- |
| DomainExchange | `0x054be4cfb6e951a7de921a179fa323c5ea3fcf47` | 0 | 0.02435456789 | — |
| EscrowV2 | `0x0ff4bd09cdbc00cd5fb9d7d270aef6a6bcb87777` | 10 | 0 | — |
| Unmapped contract | `0x159a0c1060c301290dfeb7c162bc916e7fd62c9c` | 4 | 0 | — |
| EscrowV2 | `0x18eacbf3ff19528abe8035cf5ca266f31a2e3f14` | 5 | 0 | — |
| Escrow | `0x21f007107269ea1c8fe0730736548090f4945736` | 15.31808 | 0 | — |
| Escrow | `0x2f121cddca6d652f35e8b3e560f9760898888888` | 2603.342609 | 0 | 1 wei WETH |
| StakeVaultOptIn | `0x4d16f4a9946cfc76b1c1a4b63aa9d94cda2dbceb` | 3.105263 | 0 | — |
| EscrowV2 | `0x53a535b2cbed0740fa834007bfef8b1c6519306d` | 8.734093 | 0 | — |
| Escrow | `0x5c2a8d9246777ee4501b6c426a8b8c7635c7b5b5` | 33.177288 | 0 | — |
| StakeVault | `0x5c570d2be2bfd8960b2b9f8d2d3c8148a1e24c5f` | 7.51 | 0 | — |
| AcrossBridgeHook | `0x72c10b838cf46649691949c285e0b468b363b9f0` | 46.549747 | 0 | — |
| EscrowV2 | `0x77e8f808fe201075e0bd651cd46fdf239fc83265` | 65.204713 | 0 | — |
| Escrow | `0x8455b9a31041125c785044f45458ecf2cbb12ef7` | 2.14411 | 0 | — |
| Orchestrator | `0x88888883ed048ff0a415271b28b2f52d431810d0` | 0 | 0 | 1 wei WETH |
| StakeVault, StakeVaultMethodScoped | `0x92d7b59e99e1cd2066540cd2413b8714948b731f` | 1 | 0 | — |
| Escrow | `0xc8cd114c6274ef1066840337e7678bc9731bea68` | 18.863057 | 0 | — |
| StakeVaultV2 | `0xc9e36a036274530ebd28f97f4edac212addef01e` | 10.727985 | 0 | — |
| Escrow | `0xca38607d85e8f6294dc10728669605e6664c2d70` | 850.256501 | 0 | — |
| HDFCRamp | `0xc137d22fa93316df55b5f896f5180c722d02b01d` | 38 | 0 | — |
| RevolutRamp | `0x84268621b45c24a7a2a3fb700156b0d5ac75ee0b` | 1 | 0 | — |
| VenmoRampV2 | `0x80e5ab2921e23192b2454f6a386fd7032dad932e` | 16 | 0 | — |

## Historical Safe handoff

Safe: `0x0bC26FF515411396DD588Abd6Ef6846E04470227`. Current owner of all six: `0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929`. All six nominate the Safe. The Safe acceptance batch is prepared at nonce 86, but the Safe still has nonce 86 and requires both existing owners. Do not report these as migrated until execution and owner readback.

| Contract | Address | Status |
| --- | --- | --- |
| ChargebackVerifier | `0x0fbf2c7ca3558125c73e0ab7c269eb7cf37454f4` | Safe acceptance pending; zero audited asset balances |
| ChargebackPolicy | `0x2ea164bbb11c709fcd46fe59340ce758ae553a5c` | Safe acceptance pending; zero audited asset balances |
| DisputeProtectionPolicyMethodScoped | `0x46b6d18e641c14dfb15a01f767fd33cc0a6e3488` | Safe acceptance pending; zero audited asset balances |
| StakeVault | `0x57ec47d27fb0e1911c7d1813685c602c3c56ff91` | Safe acceptance pending; zero audited asset balances |
| StakeVault | `0x8b8e853f47e6e0d3944e3689197b35216933ddea` | Safe acceptance pending; zero audited asset balances |
| DisputeProtectionPolicy | `0xc086b6120b5e61ef48221e6a78c69737c9948df9` | Safe acceptance pending; zero audited asset balances |

The two missing nominations were confirmed in transactions [0x23cb8b50…](https://basescan.org/tx/0x23cb8b50e64db0e090332e3ccaccf0bc2aa291d5e6576cde63639cf8946c01e7) and [0x9e119f1d…](https://basescan.org/tx/0x9e119f1de941cb8d4937afe0c247e204412f94b531a64d1558073bd7c1f9b3a9). The six-call acceptance hash is `0x151feb7b9e3ef38c7e512bc433b4d6f7cfb9cd66d2c46a020add43b87a605fba`. Its execution at nonce 86 would supersede competing nonce-86 proposals; this document does not cancel them.

## Inventory and unresolved retirement candidates

[The complete address register](../../audits/deployment-status-2026-10-22.json) records 403 Base addresses, owners/read failures, native and three-token balances, seven production registry checks, source provenance and support classification. It also preserves the 11 unclassified Scroll addresses from the earlier scan without claiming fresh asset checks.

| Classification | Addresses |
| --- | ---: |
| historical-review-only | 257 |
| historical-safe-acceptance-pending | 6 |
| legacy-connected | 9 |
| legacy-funded | 14 |
| retired-verification-path | 2 |
| supported-production | 27 |
| supported-staging | 42 |
| unclassified | 46 |

The earlier exclusion list contains **31 unclassified Base contracts owned by 0x84, 12 unclassified Base contracts owned by 0xdd93, and 11 Scroll contracts**. They remain unclassified, not certified empty. One of the 31, `0x159a0c1060c301290dfeb7c162bc916e7fd62c9c`, holds **4 USDC**. Other networks and nonstandard roles are not exhaustively covered.

The separate staging migration completed 26 owners to `0x41123d6419C7b8e44157f6F3b0088442116641eC`; 168 verified staging owners remain on the historical `0xdd93…80F3` signer. See [PR #359](https://github.com/zkp2p/zkp2p-contracts/pull/359) for its separate signer configuration and receipts. Ownership transfers do not rotate group curator/rate-manager roles, fee/dust recipients, per-deposit authority or service credentials.

## Evidence limits

- Reads are pinned to one Base block. All 403 native/token balance and seven registry-membership sets succeeded; unsupported `owner()` getters are recorded as errors rather than interpreted as absent authority.
- Asset coverage is ETH, Base USDC, USDbC and WETH. These are useful positive/negative checks, not a complete ERC20/NFT census. Nonzero stake accounting on the OptIn vault was independently read.
- Current deployed no-argument dependency getters and all 13 payment routes were checked. Per-deposit hooks/gating/guardians, all pending lifecycle snapshots, arbitrary custom roles, client routing and allowances were not exhaustively enumerated.
- Known historical candidates are deprioritized for new development; incomplete retirement checks remain explicit. Do not turn this register into an assertion that every old key or every historical deployment is harmless.
- The 403 addresses are an incident-inventory union, not every contract ever deployed by every project wallet. Prior V1 production ramps and unscanned networks need their own balance/recovery inventory.
