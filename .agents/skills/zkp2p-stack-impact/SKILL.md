---
name: zkp2p-stack-impact
description: Audit and coordinate ZKP2P changes across the protocol workspace and active downstream products. Use for contract, package, schema, API, provider, client, mobile, admin, monitoring, release, or deployment changes that can cross repository boundaries.
---

# ZKP2P Stack Impact

Use this skill before finalizing any change that can affect another ZKP2P
repository, package, runtime, deployment, or operator surface.

## Non-Negotiable Model

- zkp2p/protocol is a coordination workspace, not a source-code monorepo.
- workspace.yaml is the source of truth for mandatory clones, root links, and
  local package edges.
- Every linked child owns its own branch, commit, PR, CI, package release,
  release branches, migration runbook, and deployment.
- Never copy or mirror child source into protocol. Never substitute a protocol
  PR for an owning-child PR.
- Use a hard cutover. Remove retired routes, exports, aliases, dual reads,
  dual writes, and fallbacks instead of preserving compatibility.
- Immutable history may retain old names or coordinates, but active source,
  generated packages, clients, docs, release instructions, and deployments must
  use the current boundary only.

## Protocol Workspace

These six repositories are mandatory workspace members:

| Root link | Repository | Ownership |
|---|---|---|
| contracts/ | zkp2p/zkp2p-contracts | contracts, deployments, @zkp2p/contracts-v2 |
| indexer/ | zkp2p/zkp2p-indexer | Envio indexer, GraphQL schema, @zkp2p/indexer-schema |
| curator/ | zkp2p/curator | Curator API, provider templates, Prisma data model |
| attestor/ | zkp2p/attestation-service | attestation API, Nitro deployment, @zkp2p/zkp2p-attestation |
| hq/ | zkp2p/PeerHQ-Admin | admin UI and Curator schema mirror |
| monitor/ | zkp2p/monitoring | status API, probes, alerts, operator runbook |

Do not add a repository to workspace.yaml merely because it may be affected.
Every manifest member is cloned, installed, linked, and required by workspace
doctor. Keep impact-only products outside the manifest unless the workspace
contract is intentionally expanded.

## Active Downstream Ownership

| Repository or path | Active ownership |
|---|---|
| zkp2p/zkp2p-clients | web, extension, developer workbench, @zkp2p/sdk, @zkp2p/core, React packages |
| zkp2p/zkp2p-clients/clients/docs | public protocol and integration documentation |
| zkp2p/zkp2p-clients/clients/support | help center and support-bot knowledge export |
| zkp2p/pay | merchant API, checkout, dashboard, merchant SDK, and Pay-owned docs |
| zkp2p/zkp2p-mobile | Peer mobile application |
| zkp2p/zkp2p-mobile/packages/zkp2p-react-native-sdk | active embedded React Native package used by the mobile repository |
| zkp2p/peer-cash and zkp2p/peer-cli | SDK facades and operator/developer clients when their imported boundaries change |
| zkp2p/zkp2p-indexer-proxy | GraphQL transport, auth, quotas, and fixtures when indexer behavior changes |
| zkp2p/notification-server | event, webhook, address, and notification consumer |
| zkp2p/zkp2p-support-bot | active support and operations automation when its concrete inputs change |
| dashboards, miniapps, relayers, and earn products | inspect only when a direct schema, API, address, event, or package dependency is proven |

The following standalone repositories are archived and are never PR, publish,
release, or deploy targets:

- zkp2p/docs
- zkp2p/support
- zkp2p/zkp2p-react-native-sdk
- zkp2p/providers
- zkp2p/signal-dispatcher

Do not confuse archived standalone repositories with their active owners inside
zkp2p-clients, zkp2p-mobile, or curator. Do not reopen an archived repository
to preserve a compatibility path. Leave immutable Git history untouched.
Repository retirement does not rename an active workspace package: the
`@zkp2p/docs`, `@zkp2p/support`, and `@zkp2p/zkp2p-react-native-sdk` package
identities remain owned by their current containing repositories.

## Trigger Matrix

| Boundary changed | Inspect direct consumers |
|---|---|
| Contract ABI, address, event, verifier, payment method, hook, fee, oracle, or @zkp2p/contracts-v2 export | indexer, attestor, curator, clients, Pay, mobile, relayers, and event consumers |
| Indexer entity, GraphQL field, enum, webhook, deployment config, or @zkp2p/indexer-schema export | curator, clients, Pay, HQ/dashboards, indexer proxy, notifications, support bot, CLI/SDK products |
| Attestor route, action type, platform, typed data, signer, error, metadata, URL, or package export | curator, clients, Pay, mobile, support bot, and dispute/admin tools that parse it |
| Curator API, quote, provider template, credential, auth, platform, rail, or proxy behavior | clients, Pay, mobile, peer-cash, peer-cli, miniapps, support bot, and affected repo-owned docs |
| Curator Prisma model, migration, control-plane field, API key, fee, referral, blocklist, or global config | HQ first, then any direct DB or API consumer |
| @zkp2p/sdk, @zkp2p/core, extension message, or client runtime default | Pay, mobile embedded package/app, peer-cash, peer-cli, support bot, developer/docs/support workspaces |
| User-visible platform, fee, error, remediation, or integration behavior | the owning product plus clients/docs, clients/support, clients/developer, Pay docs, or mobile copy when affected |
| Health endpoint, auth, status payload, service coordinate, or alert semantics | monitoring, HQ status, watchdogs, release docs, and operators |
| Release branch, environment key, hostname, package version, or deploy source | owning runbook, deployment registry, CI, package consumers, and live read-only checks |

This matrix is an audit starting point, not permission to create awareness-only
PRs. Prove each consumer with imports, manifests, lockfiles, API calls, schema
usage, environment configuration, fixtures, deployment wiring, or current
documentation.

## Workflow

1. State a falsifiable invariant.

   Define what is active, what is removed, whether history is immutable, and
   what fail-closed behavior must result.

2. Prefer the protocol workspace for core-stack inspection.

       cd /path/to/protocol
       bin/workspace doctor
       bin/workspace status
       bin/workspace package-status

   Run bin/workspace sync only when clone/fetch/link mutation is in scope.
   Do not run a root package-manager command; protocol intentionally has none.

3. Read AGENTS.md and relevant local skills in every affected owning
   repository.

4. Inspect repositories independently.

       git -C contracts status --short --branch
       git -C contracts diff --name-only origin/main...HEAD
       git -C contracts diff --name-only

   Repeat for every affected link. For impact-only downstream repositories, use
   a clean checkout or worktree from current origin/main. A root Git diff does
   not contain child changes.

5. Trace the boundary before selecting downstream work.

   Search for package names, exported symbols, routes, GraphQL fields, Prisma
   models, provider keys, URLs, environment variables, addresses, event names,
   fixtures, generated artifacts, release branches, and public behavior.
   Re-audit current main instead of relying on old PRs or remembered topology.

6. Classify every candidate.

   - CHANGE: a concrete active consumer must change.
   - VERIFY: a concrete consumer should remain unchanged but needs a focused
     regression check.
   - NO IMPACT: no direct dependency exists; record the evidence.
   - ARCHIVED/HISTORY: never an implementation target.

7. Apply the hard cut across every active layer.

   Remove retired source, generated artifacts, schemas, exports, tests,
   fixtures, docs, routes, selections, caches, projections, and release
   instructions. Plan data cleanup or reindexing when stale rows can remain
   visible. Do not add a decoder-only legacy map or UI fallback.

8. Create one focused PR per owning repository.

   Root coordination documentation belongs in protocol. Runtime, package,
   schema, client, admin, and deployment changes belong in their standalone
   repositories. Do not create empty PRs.

9. Order the rollout.

   Record contracts/operator actions, package publish order, consumer version
   bumps, merge order, release-branch promotion, deploy order, migrations or
   reindexing, cache invalidation, and fail-closed live verification. Require
   explicit approval for live contracts, data deletion, migrations, package
   publication, release promotion, or deployment.

   Do not infer runtime deploy order from merge or package order. A producer
   package may publish first so consumers can compile, while a hard removal
   often requires deploying updated consumers before the producer runtime.
   Follow each package owner's SemVer policy and never hide a breaking public
   API change in a routine patch release.

10. Validate each owner independently, then validate the stack.

    Use the owning repository's commands and runbooks. When more than one core
    repository changes, also use protocol-e2e-test from the protocol root.
    Local workspace package links are development aids; published versions and
    standalone lockfiles remain the release contract.

## Review Gates

- Every active change has an owning repository and PR.
- Every claimed downstream has concrete dependency evidence.
- Archived standalone docs, support, RN SDK, providers, and signal dispatcher
  are excluded from active PR, package, release, and deploy plans.
- Repo-owned docs and support surfaces are updated with their active code owner.
- Protocol contains coordination metadata only; no child source or feature ref
  is committed.
- Package producers build before consumers; consumer manifests and lockfiles use
  published versions before standalone CI and deployment.
- Database, indexer, cache, and materialized-state cleanup prevents stale active
  behavior after a hard cut.
- Historical records remain historical and are not imported by runtime,
  package, client, or deployment code.
- Rollback means shipping corrected current-only code or data, never restoring
  a retired compatibility path.
- git diff --check and repository-focused validation pass in every PR.
- Live verification is read-only unless the user explicitly authorized a
  mutation.

## Report

    Stack impact:
    - Invariant:
    - Workspace members and commits:
    - Active boundary changed:
    - CHANGE repositories and PRs:
    - VERIFY repositories and evidence:
    - NO IMPACT repositories and evidence:
    - Archived/history exclusions:
    - Package publish order:
    - Merge order:
    - Data or reindex actions:
    - Deploy order:
    - Validation:
    - Approvals required:
    - Remaining risks:
    - Blocking questions:
