---
name: zkp2p-contracts-publish
description: >
  Prepare and publish @zkp2p/contracts-v2 through the protected GitHub Actions
  trusted-publishing workflow. Use for RC version selection, release validation,
  ABI/address checks, fast CI-equivalent Foundry gating, npm OIDC publication,
  registry verification, or safe post-publish recovery.
---

# `@zkp2p/contracts-v2` trusted release

Read `NPM_RELEASE.md` completely before preparing or initiating a release. Do not use local `npm publish`, `npm dist-tag`, an OTP, or an `NPM_TOKEN` as the normal release path.

## Package and workflow

- Package: `packages/contracts/`
- Version source: `packages/contracts/package.json`
- Workflow: `.github/workflows/publish-contracts-v2.yml`
- Autonomous RC environment: `npm-publish-rc`
- Registry tag: hard-coded `rc`

The workflow must be dispatched from `main`. Its `release` input must exactly match the committed `0.4.0-rc.N` package version, the repository-controlled `contracts-v2-v<version>` tag must point to that same main commit, and live `latest` must match the repository-controlled `0.3.0` baseline. Every version must be new on npm.

## Prepare the version PR

Set the first unused `0.4.0-rc.N` version. Stable or `latest` publishing is a separate future workflow and is not implemented here. Do not reuse or overwrite an npm version.

Update the package README or changelog for consumer-visible changes. Confirm `repository.url` remains exactly `https://github.com/zkp2p/zkp2p-contracts.git` for npm OIDC provenance.

## Fast preflight and full test gate

Do not rerun the full Foundry suite serially before a release when the exact commit already passed normal CI. Run the package-specific preflight locally from a clean checkout:

```bash
yarn install --immutable
yarn compile
yarn pkg:build
yarn pkg:test
yarn workspace @zkp2p/contracts-v2 verify:release
yarn test:release-policy
(cd packages/contracts && npm pack --dry-run)
```

The verification derives required ABIs and addresses from the current hard-cut package and must match exact Base/Base Staging deployment artifacts. Normal CI and the publishing workflow remain authoritative for the complete Foundry suite.

The release workflow mirrors CI's fast structure:

- package compile, integrity checks, pack, and tarball smoke test run in one job;
- the complete Foundry suite runs concurrently in another job;
- the Foundry job restores `out` and `cache_forge` from a key derived from `foundry.toml`, Solidity sources, Foundry tests, and `forge-std`;
- publication requires both jobs, so optimization must never remove or weaken the full-suite gate.

## Initiate and verify

After the version PR and normal CI merge to `main`, create `contracts-v2-v<version>` at the exact merge commit and dispatch **Publish contracts-v2** from `main` with the exact version. The `npm-publish-rc` environment has no reviewer or secret and permits only `main`, so RC publication is autonomous.

The publish job uses OIDC with `id-token: write`, publishes the validated tarball using `npm publish --tag rc --provenance`, and checks registry integrity, provenance, unchanged `latest`, exact-version and `@rc` clean installs, required exports, ABIs, and addresses.

If npm accepted the version but post-publish verification failed, do not rerun the publish. Inspect the immutable version and repair only a wrong dist-tag through an interactive maintainer action protected by 2FA.

For registry propagation failures only, follow the recovery procedure in `NPM_RELEASE.md`. Recovery must run from canonical `main`, accept only the original release tag as an ancestor plus the allowlisted release-only files, rebuild the exact package, rerun all release gates, and verify the registry without OIDC or publication.
