---
name: zkp2p-contracts-publish
description: >
  Prepare and publish @zkp2p/contracts-v2 through the protected GitHub Actions
  trusted-publishing workflow, including build, tests, ABI/address integrity,
  npm pack, provenance, dist-tag, and post-publish verification.
compatibility: Requires Node.js 22.14+, Yarn 4.9.1, and maintainer access to dispatch and approve GitHub environments.
---

# `@zkp2p/contracts-v2` trusted release

Read `NPM_RELEASE.md` completely before preparing or initiating a release. Do not use local `npm publish`, `npm dist-tag`, an OTP, or an `NPM_TOKEN` as the normal release path.

## Package and workflow

- Package: `packages/contracts/`
- Version source: `packages/contracts/package.json`
- Workflow: `.github/workflows/publish-contracts-v2.yml`
- Protected environment: `npm-publish`
- Registry tags: `dev` or `rc` for prerelease SemVer; `latest` for stable SemVer

The workflow must be dispatched from `main`. Its `release` input must exactly match the committed package version. Every version must be new on npm.

## Prepare the version PR

For a prerelease, set an explicit prerelease version. For stable, remove the prerelease suffix in a separate reviewed PR. Do not reuse or overwrite an npm version.

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

## Initiate, approve, and verify

After the version PR and normal CI merge to `main`, dispatch **Publish contracts-v2** with the exact version and intended tag. The validation job performs the authoritative immutable install/build/test/pack checks and preserves the exact tarball. Review those results before a different human approves the `npm-publish` environment.

The publish job uses OIDC with `id-token: write`, publishes that exact tarball with provenance, and checks the registry version, selected dist-tag, integrity, and required files. Do not publish if any gate fails.

If npm accepted the version but post-publish verification failed, do not rerun the publish. Inspect the immutable version and repair only a wrong dist-tag through an interactive maintainer action protected by 2FA.
