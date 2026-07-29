---
name: zkp2p-contracts-publish
description: >
  Prepare and publish @zkp2p/contracts-v2 through the protected GitHub Actions
  trusted-publishing workflow, including build, tests, ABI/address integrity,
  npm pack, provenance, dist-tag, and post-publish verification.
compatibility: Requires Node.js 22.14+, Yarn 4.9.1, and maintainer access to dispatch the autonomous RC workflow.
---

# `@zkp2p/contracts-v2` trusted release

Read `NPM_RELEASE.md` completely before preparing or initiating a release. Do not use local `npm publish`, `npm dist-tag`, an OTP, or an `NPM_TOKEN` as the normal release path.

## Package and workflow

- Package: `packages/contracts/`
- Version source: `packages/contracts/package.json`
- Workflow: `.github/workflows/publish-contracts-v2.yml`
- Autonomous RC environment: `npm-publish-rc`
- Registry tag: hard-coded `rc`

The workflow must be dispatched from `main`. Its `release` input must exactly match the committed `0.4.0-rc.N` package version, and the repository-controlled `contracts-v2-v<version>` tag must point to that same main commit. Every version must be new on npm.

## Prepare the version PR

Set the first unused `0.4.0-rc.N` version. Stable or `latest` publishing is a separate future workflow and is not implemented here. Do not reuse or overwrite an npm version.

Update the package README or changelog for consumer-visible changes. Confirm `repository.url` remains exactly `https://github.com/zkp2p/zkp2p-contracts.git` for npm OIDC provenance.

## Local preflight

From a clean checkout with the tracked non-production environment defaults loaded:

```bash
yarn install --immutable
yarn build
yarn pkg:build
yarn pkg:test
yarn workspace @zkp2p/contracts-v2 verify:release
cd packages/contracts
npm pack --dry-run
```

The verification derives required ABIs and addresses from the current hard-cut package and must match exact Base/Base Staging deployment artifacts.

## Initiate and verify

After the version PR and normal CI merge to `main`, create `contracts-v2-v<version>` at the exact merge commit and dispatch **Publish contracts-v2** from `main` with the exact version. The `npm-publish-rc` environment has no reviewer or secret and permits only `main`, so RC publication is autonomous.

The publish job uses OIDC with `id-token: write`, publishes the validated tarball using `npm publish --tag rc --provenance`, and checks registry integrity, provenance, unchanged `latest`, exact-version and `@rc` clean installs, required exports, ABIs, and addresses.

If npm accepted the version but post-publish verification failed, do not rerun the publish. Inspect the immutable version and repair only a wrong dist-tag through an interactive maintainer action protected by 2FA.
