---
name: zkp2p-contracts-publish
description: >
  Prepare, initiate, and verify @zkp2p/contracts-v2 releases through the
  repository's protected GitHub Actions trusted publisher. Use for release-line
  discovery, RC selection, package and address validation, pinned Foundry
  gating, npm OIDC publication, registry verification, or post-publish
  recovery. Never hard-code a release line or publish locally.
---

# Trusted contracts package release

Read `NPM_RELEASE.md`, the active publishing workflow, package manifest, and
release-policy scripts completely before preparing a release. The repository
policy and workflow are authoritative.

Do not use local `npm publish`, `npm dist-tag`, an OTP, `NPM_TOKEN`, or another
developer credential as the normal release path.

## Determine the current policy

Read, do not assume:

- package name and candidate from `packages/contracts/package.json`;
- release line, dist-tag, latest baseline, environment, and allowed input shape
  from `.github/workflows/publish-contracts-v2.yml`;
- canonical tag format and recovery allowlist from `NPM_RELEASE.md`;
- pinned Foundry version from the active CI and publish workflows.

Derive the release line by removing the allowed prerelease suffix from the
package candidate and require it to equal the workflow's release-line policy.
Do not carry a version from an older release or this skill.

Query the live npm registry and select the first unused candidate permitted by
the current policy. Every npm version is immutable.

## Canonical release source

Do not trust a checkout's `origin`, a contributor fork, or a legacy redirect.
Resolve the release source through the canonical repository explicitly:

```bash
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git \
  "+main:${canonical_main_ref}"
git rev-parse "$canonical_main_ref"
git rev-parse HEAD
```

Tags, workflow dispatch, package version, and CI evidence must all resolve to
the same canonical-main commit.

## Modes and approvals

- Audit: read registry, workflow, package, tags, and CI only.
- Prepare: change version and consumer-facing metadata in a focused PR.
- RC publish: requires explicit approval for the exact version, commit, tag,
  dist-tag, and workflow dispatch.
- Stable publish: requires separate explicit approval and a repository workflow
  that implements stable publication.

If stable publication is not implemented by current policy, stop. Do not adapt
the RC workflow or publish locally.

## Prepare the version PR

Keep package version, release-policy files, and consumer-visible documentation
consistent. Confirm package repository metadata points to
`https://github.com/zkp2p/zkp2p-contracts.git`.

Do not create or move a release tag before the version PR merges to canonical
`main`. Do not reuse an existing registry version.

## Local preflight

Use a clean checkout and the repository-pinned Node/Yarn/Foundry setup. Confirm
local `forge --version` matches the active workflow pin; otherwise rely on CI
for Foundry evidence rather than claiming parity.

```bash
yarn install --immutable
yarn compile
yarn pkg:build
yarn pkg:test
yarn workspace @zkp2p/contracts-v2 verify:release
yarn test:release-policy
(cd packages/contracts && npm pack --dry-run --ignore-scripts --json)
```

The release verifier must prove current hard-cut package exports, canonical
source ABIs, and exact Base/Base Staging deployment addresses.

Do not rerun the complete Foundry suite locally when the exact commit is already
green in current CI. The publish workflow's pinned full-suite job remains an
authoritative gate and must not be weakened or skipped.

## Initiate

After merge and current CI:

1. Resolve canonical `main` and its exact commit.
2. Confirm the candidate is still unused in npm.
3. Obtain explicit approval to create the exact release tag and dispatch the
   trusted workflow for the named version, commit, release line, and dist-tag.
4. Create the repository-controlled package tag required by current policy at
   that exact commit.
5. Recheck tag SHA, workflow SHA, package version, release line, dist-tag, and
   latest baseline.
6. Dispatch the trusted publishing workflow from canonical `main`. If any
   checked value changed after approval, stop and obtain new approval.

The publish job must use GitHub OIDC provenance and the protected environment
defined by current policy.

## Verify

Require:

- workflow validation and pinned Foundry jobs passed for the published commit;
- npm exact version and intended dist-tag match;
- stable/latest remains unchanged for an RC;
- registry integrity and provenance match the validated tarball;
- clean installs of the exact version and intended tag expose required ABIs,
  addresses, and module formats.

## Recovery

If npm accepted an immutable version but registry propagation caused only a
post-publish verification failure, follow `NPM_RELEASE.md` recovery exactly.
Recovery verifies; it must not obtain OIDC publication authority or republish.

Recovery must run from canonical `main` with `release_run_id` set to the
original non-recovery publish run whose validated tarball npm accepted. Require
the original release tag to be an ancestor, permit only the runbook's
allowlisted release-only files after that tag, rebuild the package, rerun every
release gate, compare registry integrity to the original validated tarball, and
verify the registry without OIDC publication authority.

For content, integrity, version, provenance, or dist-tag disagreement, stop and
prepare a new forward-fix version unless current policy explicitly authorizes a
protected maintainer correction. Never rerun publication blindly.

## Report

Report current release policy, derived release line, exact candidate, source and
tag SHAs, approvals, local preflight, pinned CI/Foundry evidence, workflow URL,
registry/provenance verification, and any stable boundary left unimplemented.
