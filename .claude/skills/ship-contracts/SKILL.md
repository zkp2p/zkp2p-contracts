---
name: ship-contracts
description: >
  Prepare and coordinate zkp2p-contracts deployment changes across source,
  staging activation, production activation, package export, RC publication,
  and stable publication. Use when asked to ship or deploy contracts. Keep
  these as separately reviewed and approved boundaries, use hard cutovers, and
  delegate every package release to zkp2p-contracts-publish.
---

# Ship contracts

Shipping is not one automatic pipeline. Treat each boundary as an independent
deliverable with its own evidence and explicit authorization:

1. source and network-scoped deployment lane;
2. staging activation;
3. production activation;
4. package export;
5. RC publication;
6. stable publication.

Approval for one boundary does not authorize the next. Never infer production,
RC, or stable approval from "deploy staging" or "ship the code."

## Establish current state

Resolve canonical main explicitly; do not trust a checkout's `origin`, a
contributor fork, or a legacy redirect:

```bash
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git \
  "+main:${canonical_main_ref}"
git rev-parse "$canonical_main_ref"
git rev-parse HEAD
```

Record the source SHA, deployment artifacts, active runner, package version,
and live target network before preparing a plan.

Read:

- `AGENTS.md`;
- the affected contracts and interfaces;
- `scripts/deployActive.ts`;
- the closest current deploy scripts and Foundry deployment tests;
- `deployments/parameters.ts`, target artifacts, and package extraction;
- `.agents/skills/zkp2p-contracts-publish/SKILL.md` for any release.

Do not route through the legacy repository name or an archived deployment lane.

## Boundary 1: source and network-scoped deployment lane

Create the smallest source, interface, deployment, and test changes that encode
the approved target state.

- Keep source, a mounted deploy lane, checked-in artifacts, and verified live
  activation as distinct states.
- Do not add a deploy script merely because source exists.
- Treat `OrchestratorV3` as a dedicated implementation. Its current lifecycle
  design intentionally differs from V2. Its mounted lane `30` supports
  `localhost`, `hardhat`, Base staging, and an explicitly gated Base
  whitelist-only deployment.
- Base lane `30` requires `ENABLE_BASE_V3_GROUPS_CUTOVER=true`, a separately
  reviewed exact source SHA, and the production governance/deployer path. It
  must leave existing orchestrators registered and produce only the fresh O3
  registry-add Safe call. Lane `31` remains outside that deployment.
- Remove retired active routes, permissions, exports, and aliases in the same
  hard cutover.
- Do not add rollback compatibility to a one-way verifier or nullifier
  migration.

Numbered deploy metadata is immutable identity only when current tooling
requires it. Before retaining an inactive numbered script, prove from
`scripts/deployActive.ts`, its `skip` logic, network guards, deployment tests,
and package export that it cannot execute or surface as active state. If the
active runner loads it and the proof is absent, remove or disable the active
lane rather than documenting intent.

Validate with the smallest Foundry and deployment checks required by
`AGENTS.md`. Source preparation must not mutate a live network.

## Boundary 2: staging activation

Require explicit approval naming Base staging and the exact source SHA.

Before activation:

- verify deployer, chain ID, RPC, parameters, expected old state, and expected
  new state;
- for lane `30`, resolve the expected `OrchestratorV3`,
  `UnifiedPaymentVerifierV3`, lifecycle hook, stake vault, dispute policy,
  verifier/nullifier, registries, ownership, and prior-orchestrator state from
  current source and artifacts;
- simulate or run the closest local deployment test;
- show every deploy, registry, permission, ownership, and governance action;
- define post-deploy reads that prove the hard cut.

After activation, verify on-chain state and record addresses, transaction hashes,
ownership, permissions, and artifacts. Do not publish an RC automatically.

## Boundary 3: production activation

Require a separate explicit approval naming Base production, exact source SHA,
and governance/deployer path. Re-run state and simulation checks against
production immediately before submission.

The Base whitelist-only lane must be reviewed at an exact source SHA. Require
the explicit Base cutover flag, retain existing orchestrators, and verify that
the generated Safe batch contains only `addOrchestrator(freshO3)`. Do not reuse
staging artifacts or include lane `31` as a shortcut.

Fail closed on chain, address, signer, ownership, permission, or expected-state
mismatch. Do not reuse staging approval. Do not publish a package automatically.

## Boundary 4: package export

Package extraction is a source artifact boundary, not publication. Confirm:

- exported ABIs match canonical source;
- each network's addresses match that network's deployment artifacts;
- Base-staging V3 lifecycle addresses remain distinct from Base production
  exports and claims;
- source ABI exports required by current package/release policy may exist
  without an address on another network, but must never imply activation there;
- consumer-visible changes are documented and tested.

Run package build, tests, release verification, and dry-run packing without
publishing.

## Boundaries 5 and 6: publication

Delegate both RC and stable requests to
`.agents/skills/zkp2p-contracts-publish/SKILL.md`.

- Require separate approval for RC publication.
- Require another separate approval for stable publication.
- Derive the release line and candidate from current package and repository
  release policy.
- Never run local `npm publish`, request an OTP, use a developer token, or move
  a dist-tag as this skill.
- If the trusted workflow does not implement the requested stable path, stop
  and request a focused release-policy/workflow PR. Do not improvise a local
  stable release.

## Handoff

For each boundary, report:

- exact source commit and network/package target;
- actions prepared versus actions executed;
- approval obtained for that boundary;
- focused validation and current CI;
- addresses, transactions, artifacts, package candidate, or release URL;
- the next boundary, explicitly marked unapproved until the user authorizes it.
