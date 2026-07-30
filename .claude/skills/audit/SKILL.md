---
name: audit
description: >
  Review zkp2p-contracts for security and correctness issues. Use for full
  audits, current-branch differential reviews, pull-request reviews, focused
  invariant checks, or V2-to-V3 invariant parity checks. Resolve a fresh
  canonical main baseline, stay read-only unless the user explicitly requests
  an artifact, and apply branch-introduction gates only to differential work.
---

# Audit zkp2p-contracts

Default to a read-only review. Do not edit code, write an audit report, stage,
commit, push, or open a PR unless the user explicitly asks for that mutation.

## Modes

- `full`: inspect the requested contracts and their security boundaries.
- `diff`: review the current branch against canonical `main`.
- `pr <number>`: review the current head of the named PR.
- `check <area>`: inspect one invariant, contract, or failure class.
- `v3-parity`: verify shared V2/V3 invariants while preserving the current
  intentional V3 lifecycle, hook, settlement, and deployment differences.

If the request is explanatory or read-only, do not compile or test unless the
answer depends on execution.

## Establish current evidence

The canonical repository is `zkp2p/zkp2p-contracts`. Do not trust a checkout's
remote name, contributor fork, or legacy redirect as proof of that baseline.

For a branch review:

```bash
git remote get-url origin
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git \
  "+main:${canonical_main_ref}"
git rev-parse "$canonical_main_ref"
git rev-parse HEAD
git diff --stat "$canonical_main_ref...HEAD"
git diff --name-status "$canonical_main_ref...HEAD"
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

For `diff` and `pr` modes, a blocking finding must be:

1. introduced or materially worsened by the reviewed branch or PR;
2. material to correctness, security, deployment, or a named invariant;
3. reproducible or supported by current code evidence;
4. actionable within the branch's ownership boundary.

For `full`, `check`, and `v3-parity`, classify every material finding supported
by the selected revision, regardless of when it entered the repository. Label
inherited or baseline findings accurately; branch ownership limits the proposed
remediation, not whether the audit may report the issue.

In differential work, report inherited bugs, baseline failures, theoretical
risks, unavailable checks, and pending CI separately. Do not block that branch
on them unless it materially worsens the condition.

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

## OrchestratorV3 invariant parity

`OrchestratorV3` is a dedicated current implementation with a mounted
Base-staging lifecycle lane, not a textual V2 scaffold. Current source retains
the relayer-gated multi-intent admission and core escrow, fee, registry, and
payment-verification boundaries. It intentionally replaces the V2
deposit-whitelist-hook path with a governance-selected lifecycle hook
snapshotted per intent and fail-closed callbacks across signal, cancellation,
fulfillment, and manual release.

When either V2 or V3 source changes:

1. Diff both implementations and interfaces against canonical current main.
2. Derive the intended V3 deltas from current interfaces, lifecycle tests,
   deployment tests, and `deploy/30_deploy_v3_lifecycle_stack.ts`; do not copy an
   allowlist from an older review.
3. Verify shared admission, fee, escrow, registry, payment-verifier, nullifier,
   replay, authorization, and settlement invariants semantically.
4. Verify the V3 lifecycle-hook snapshot, callback ordering, fail-closed
   behavior, reentrancy protection, cancellation/pruning, and chargeback/stake
   ownership boundaries with the closest deterministic, fuzz, invariant, and
   integration tests.
5. Inspect `scripts/deployActive.ts`, lane `30` network guards and `skip`
   behavior, Base-staging artifacts, package addresses, and live state
   separately. A mounted script or checked-in artifact is not production or
   live-state evidence.

Do not require the remaining V2/V3 source diff to be empty and do not normalize
away a lifecycle, storage, governance, or settlement delta. If bytecode,
storage, ABI, or selector parity is claimed for a shared component, prove that
specific claim with the pinned compiler and explicit metadata handling.

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

Lead with findings in severity order. If none meet the applicable mode's
finding standard, say so and list residual risks or unavailable evidence.
Include base/head SHAs, scope, checks run, baseline failures, branch failures,
pending CI, and whether V3 invariant parity was applicable.
