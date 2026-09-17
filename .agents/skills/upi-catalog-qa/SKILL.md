---
name: upi-catalog-qa
description: Verify UPI/INR registry registration and published contracts catalogs for the Amazon Pay UPI buyer flow.
---

# UPI catalog QA

Resolve Base or Base staging addresses and ABIs from the exact candidate package.
Using a read-only Base RPC, require `PaymentVerifierRegistry.isPaymentMethod(keccak256("upi"))`,
`getVerifier` equal to the current packaged UnifiedPaymentVerifierV3, and
`getCurrencies` equal to `[keccak256("INR")]`. Require the current verifier's
`getPaymentMethods` to contain UPI. Record chain ID, block number, package and source SHA.
This workflow does not submit governance transactions.

The extraction allowlist and `deployments/outputs/platforms/<network>.json` must
both include the verified method. Run `yarn pkg:build`, `yarn pkg:test` and
`yarn workspace @zkp2p/contracts-v2 verify:release`. The payment-method regression
must pass for raw JSON, ESM and CJS catalogs and forward/reverse hash lookups.
After publishing through the repository release skill, clean-install the exact
version and repeat catalog assertions; merely finding the word UPI in a tarball
is insufficient. Verify the downstream SDK's `getPaymentMethodsCatalog` for
`preproduction`, not just staging. Product environment flags remain owned by clients.
