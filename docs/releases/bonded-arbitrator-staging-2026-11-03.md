# Bonded arbitrator on Base staging, 2026-11-03

Lane 48 (`deploy:bonded-arbitrator:base_staging`) ran from `65e1473` after
Foundry CI and Release readiness passed on that exact commit. Signer
`0x41123d6419C7b8e44157f6F3b0088442116641eC`, nonces 149–158, 10 confirmed
transactions.

| Contract | Address | Block | Deployment tx |
| --- | --- | --- | --- |
| NonPaymentVerifier | [`0xb9281bFAFA460E3f68a0b6c4E42e8D3b2030f00a`](https://basescan.org/address/0xb9281bFAFA460E3f68a0b6c4E42e8D3b2030f00a) | 53472822 | `0x28b9bdb202723d74e8afbda9ec2cac95f729cfdcf1999f6d23983a45d398602c` |
| BondedArbitrator | [`0x3CC27551f5722b88CbB8f84a17b05b751039F3c3`](https://basescan.org/address/0x3CC27551f5722b88CbB8f84a17b05b751039F3c3) | 53472825 | `0x49366483844edcc26dee7d388bdba6103d7d5d33152028ef554dabc9d046dbd1` |
| IntentSignalPolicyV2 | [`0x45e61ce29615197ce7ab5B4Fc6bB93dD055E8eE0`](https://basescan.org/address/0x45e61ce29615197ce7ab5B4Fc6bB93dD055E8eE0) | 53472827 | `0x29fcfead154aef756305e930cce80fc17574815de078151b8e8b7991fe4f85dd` |

The remaining seven transactions:

- authorized BondedArbitrator as a StakeVaultV2 controller and a
  NullifierRegistryV2 writer;
- set a 14-day dispute window for Venmo, Cash App and Wise;
- approved the signer as bond owner;
- selected IntentSignalPolicyV2 on OrchestratorV4
  `0xd03674d06FB9d66C7F1dc9c8D45ADd314B604F2c`.

## Verification

The lane's post-checks passed. Independent reads after the run confirmed:

- OrchestratorV4 `signalPolicy()` is IntentSignalPolicyV2.
- The policy's `defaultArbitrator()` is BondedArbitrator, and its
  `gatingService()` is unchanged at `0x87eE8394DDa0F8CB89924e093f6209cfCA3045e0`.
- StakeVaultV2 `isController(BondedArbitrator)` and NullifierRegistryV2
  `isWriter(BondedArbitrator)` are both true.
- BondedArbitrator's owner and approved bond owner is the signer. Its verifier is
  NonPaymentVerifier, and the Venmo dispute window is `1209600`.
- NonPaymentVerifier's witnesses come from MultiAttestationVerifier
  `0x9855a39aC5975069632e91160d8712CBfF19e864`.

`deployments/outputs/baseStagingContracts.ts` adds only the three new entries;
all 56 existing entries are unchanged. Package extract passed.

## Not done in this run

- No stake deposit or operator authorization. Until a bond owner deposits stake
  and calls `setOperator`, `release` reverts for every caller.
- No package publish or downstream re-vendor.
- No source verification submission.
- No production change.
