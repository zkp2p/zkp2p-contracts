---
name: audit
description: >
  Review zkp2p-contracts for branch-introduced security and correctness issues.
  Use for full audits, current-branch differential reviews, pull-request
  reviews, focused invariant checks, or V2-to-V3 scaffold parity checks. Resolve
  a fresh canonical main baseline, stay read-only unless the user explicitly
  requests an artifact, and separate blocking findings from inherited,
  theoretical, unavailable, or baseline issues.
---

# Audit zkp2p-contracts

Default to a read-only review. Do not edit code, write an audit report, stage,
commit, push, or open a PR unless the user explicitly asks for that mutation.

## Modes

- `full`: inspect the requested contracts and their security boundaries.
- `diff`: review the current branch against canonical `main`.
- `pr <number>`: review the current head of the named PR.
- `check <area>`: inspect one invariant, contract, or failure class.
- `v3-parity`: verify that the retained OrchestratorV3 scaffold has not diverged
  from OrchestratorV2 beyond its explicitly allowed identity changes.

If the request is explanatory or read-only, do not compile or test unless the
answer depends on execution.

## Establish current evidence

The canonical repository is `zkp2p/zkp2p-contracts`. Follow a legacy remote
redirect to that owner; never substitute a similarly named repository.

For a branch review:

```bash
git fetch origin main
git rev-parse origin/main
git rev-parse HEAD
git diff --stat origin/main...HEAD
git diff --name-status origin/main...HEAD
```

For a PR, resolve its current head and diff through connected GitHub or `gh`,
then record both base and head SHAs. Review the current head again before merge.
Do not ask the user to paste a diff when repository access is available.

If fresh remote evidence is unavailable, state that limitation and do not
present a stale local ref as current.

## Scope

Map the exact changed or requested surface:

- production contracts, interfaces, libraries, and inherited code;
- storage layout, authorization, accounting, settlement, replay, and
  reentrancy boundaries;
- deploy scripts, governance batches, registries, permissions, and skip logic;
- deployment artifacts, package extraction, ABIs, addresses, and consumers;
- closest deterministic, fuzz, invariant, integration, and deployment tests.

Use direct searches for imports, calls, selectors, events, errors, fixtures,
and deployment consumers. Do not expand into unrelated cleanup.

## Finding standard

A blocking finding must be:

1. introduced by the reviewed branch or PR;
2. material to correctness, security, deployment, or a named invariant;
3. reproducible or supported by current code evidence;
4. actionable within the branch's ownership boundary.

Report inherited bugs, baseline failures, theoretical risks, unavailable
checks, and pending CI separately. Do not block a branch on them unless the
branch materially worsens the condition.

For every finding include severity, tight file/line scope, concrete failure
path, impact, and smallest corrective action. Do not inflate style preferences
into security findings.

## Review invariants

Check the invariants relevant to the scope:

- authorization and ownership transitions fail closed;
- locked and unlocked value, fees, refunds, and transfers conserve value;
- nullifiers and payment identifiers cannot be replayed;
- signatures bind the intended chain, deployment, contract, actor, amount, and
  expiration;
- registry and verifier cutovers remove retired active paths;
- deploy scripts are idempotent only for the exact intended state;
- package ABIs and addresses match canonical source and deployment artifacts;
- historical artifacts remain historical and cannot reactivate old semantics.

## OrchestratorV3 scaffold parity

`OrchestratorV3` and `IOrchestratorV3` are future scaffolds, not an active
deployment lane. When either V2 or V3 source changes:

1. Diff `OrchestratorV2.sol` against `OrchestratorV3.sol`.
2. Diff `IOrchestratorV2.sol` against `IOrchestratorV3.sol`.
3. Normalize only the contract/interface import, identifier, title, and
   version-specific documentation.
4. Require the remaining source diff to be empty unless the task explicitly
   authorizes V3 behavior.
5. Confirm V3 is absent from active deploy scripts, deployment outputs, package
   addresses, and production cutover instructions.

If an exact parity claim matters, run the smallest compile needed and compare
ABI, storage layout, selectors, and normalized runtime bytecode with compiler
metadata and version identifiers handled explicitly. Do not call the scaffold
byte-identical based only on a visual source diff.

## Validation

Follow `AGENTS.md`:

- markdown or explanation only: `git diff --check` when there is a diff;
- one behavior: closest deterministic Foundry target;
- shared accounting, authorization, settlement, storage, or reentrancy:
  affected deterministic plus relevant fuzz/invariant, then one full suite only
  at the finalized state when justified;
- package or public ABI: package release checks after focused contract tests.

Use the repository-pinned Foundry toolchain for executed evidence. Report CI
and local results separately.

## Output

Lead with findings in severity order. If none meet the blocker standard, say so
and list residual risks or unavailable evidence. Include base/head SHAs, scope,
checks run, baseline failures, branch failures, pending CI, and whether V3
parity was applicable.
