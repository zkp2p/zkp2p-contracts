# Onchain Risk Threat Model

## Assets and invariants

- EscrowV2 maker liquidity must remain under existing custody rules.
- A user's free StakeVault balance must equal deposits minus withdrawals,
  active reservations, active locks, and paid slashes.
- Only a snapshotted orchestrator may resolve an intent's risk position.
- Only trusted Attestor keys may register identity or authorize chargeback.
- The same platform identity cannot seed a second wallet.
- Governance changes must not rewrite active intent terms.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Many wallets controlled by one person | One wallet per Attestor-verified platform account | A person with multiple real platform accounts can register multiple identities |
| Two identities wash-trade reputation | No flat fill reward, proof-verified settlement only, square-root pair edge, edge cap, counterparty weighting | Coordinated identity farms remain possible; tune caps from observed data |
| Maker manually releases self-dealing intent | Taker and maker must differ; manual releases earn no reputation | Two separately verified controlled identities can still build one capped edge |
| Fresh identity griefs deposits | Per-intent signal bond, abandonment slash, signed negative score | Very cheap deposits may still be griefed if bond is configured too low |
| Unlimited active-intent DoS | Capital reservation plus existing per-deposit active-slot safeguard | Governance must size the shared EscrowV2 slot limit for real concurrency |
| Full deposit withdrawal prunes many expired risk positions | Signal bonds price each lock; `removeFunds` can reclaim expired liquidity incrementally | Each prune adds several cross-module calls, so the live slot limit requires a pre-cutover gas benchmark |
| Risk config disables a platform | Public owner transaction and events | Governance remains a policy trust point; use timelock/multisig |
| Attestor key compromise | Public signer allowlist, emergency deactivation, contract-wallet signatures | Compromised key can register identities or authorize chargebacks until removed |
| One signer compromise crosses trust domains | Dark deploy leaves production identity/chargeback roles empty; cutover requires distinct threshold/ERC-1271 signers for payment, identity, and chargeback | Each role remains a powerful trust root within its narrow domain |
| Existing portable identity payload is published without consent | The attested wallet must submit its own registration transaction | A compromised wallet can still register its valid payload on multiple deployments |
| Cross-chain chargeback replay | EIP-712 chain id and verifying contract | Identity attestations use the portable Attestor domain but require the wallet on each destination chain |
| Portable identity domain is reused for another action | IdentityRegistry accepts only explicitly allowlisted `register_*` action hashes | Governance must update the allowlist when Attestor adds a supported identity platform |
| Chargeback submitted after maturity | Vault pays only still-locked collateral | Maker receives no stake compensation after final maturity |
| Chargeback exceeds collateral | Each payment is capped at remaining lock; cumulative attested claims cannot exceed release amount; configured coverage stays at least 100% before maturity | Maker may receive partial compensation only after an incorrectly short final maturity or stake-token impairment |
| Partial chargeback frees future coverage | Partial evidence is single-use and residual collateral keeps maturing until the final cumulative claim | A late claim can still exceed then-available collateral |
| Attestor never finalizes a partial claim | Anyone can close the access-only hold after 30 days; collateral and later attestations are unaffected | The payer can resume while a dispute remains operationally unresolved |
| Payer strategically waits for collateral decay | Chargebackable configs require at least 100% retention and tier-adjusted coverage through final maturity | Governance must set final maturity at or beyond the rail's real dispute window |
| Policy changes during an intent | Risk manager, fee, stake ratio, tier multiplier, and maturity schedule are snapshotted | Trusted module code itself is immutable; upgrades require a new deployment |
| Risk-manager upgrade strands locks | Orchestrator snapshots manager per intent | Old manager must remain deployed and authorized until its last position resolves |
| Risk-manager upgrade bypasses an old claim | Shared StakeVault counters block new takes while any claim or negative-reputation sync is open | Old immutable manager must remain callable so anyone can finish synchronization |
| Revoked identity rotates to another node | Owner can quarantine the whole wallet without deleting identity or score history | Governance must define evidence and appeal policy for quarantine |
| Unbounded user history causes gas DoS | Position lookup by intent hash; user-supplied checkpoint batches | Wallet/indexer must help users discover matured positions |
| Maker is token-blacklisted during a slash or chargeback | Compensation is credited internally and pulled to a chosen recipient | Stake-token deposit/withdraw still depends on canonical USDC behavior |
| Reentrancy during token withdrawal | Vault and orchestrator transfer paths use reentrancy guards and SafeERC20 | Stake token must be reviewed; proposed token is canonical USDC |
| Verifier reports more than locked intent | Orchestrator rejects `releaseAmount > intent.amount` | Payment verifier remains trusted for proof semantics |
| Snapshotted risk module fails during settlement | Proof and manual fulfillment fail atomically; taker cancellation remains available | A taker who already paid fiat needs maker/offchain remediation; no unsafe collateral bypass exists |

## Governance recommendations

- Put every owner behind the same timelocked multisig or a clearly documented
  separation-of-duties model.
- Never reuse the payment-proof witness for identity or chargeback signing, and
  keep identity and chargeback keys role-separated from each other.
- Emit and index all config changes before enabling client traffic.
- Require delayed changes for platform enablement, stake ratios, maturity, tier
  thresholds, and trusted signer additions.
- Keep pause authority on the orchestrator for emergency settlement safety;
  cancellation and maturity recovery must remain available.
- Do not enable `makerIdentityRequired` until existing maker coverage is high.

## Audit focus

1. StakeVault accounting across reserve, partial fulfillment, abandonment,
   checkpoint, withdrawal, and chargeback.
2. EIP-712 compatibility with Attestor's millisecond identity fields.
3. Orchestrator callback ordering and atomic rollback behavior.
4. Contract size and gas cost for signal/fulfill.
5. Worst-case EscrowV2 expiry pruning at the configured per-deposit slot limit.
6. Reputation farming economics and initial parameter calibration.
7. Governance key and upgrade operational procedures.
