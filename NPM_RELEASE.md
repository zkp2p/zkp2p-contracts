# Autonomous trusted RC publishing for `@zkp2p/contracts-v2`

The only supported RC path is `.github/workflows/publish-contracts-v2.yml`. It publishes through GitHub Actions OIDC with npm provenance and no reusable npm credential.

## One-time npm configuration

Add this GitHub Actions trusted publisher to `@zkp2p/contracts-v2`:

| Field | Value |
| --- | --- |
| Organization | `zkp2p` |
| Repository | `zkp2p-contracts` |
| Workflow filename | `publish-contracts-v2.yml` |
| Environment | `npm-publish-rc` |
| Allowed action | `npm publish` only |

After one successful trusted publish, set publishing access to require 2FA and disallow traditional tokens where npm keeps trusted publishing available. Do not revoke any existing credential without separately confirming its ownership and consumers.

## One-time GitHub configuration

Create `npm-publish-rc` in `zkp2p/zkp2p-contracts` with:

- no required reviewer and no wait timer;
- custom deployment branch policy allowing exactly `main`;
- no environment secrets or variables, especially no `NPM_TOKEN`.

The validation job reads the environment and deployment-branch policy through GitHub's API and fails closed unless the environment is autonomous and main-only. The publish job alone receives `id-token: write`.

## Preparing an RC

1. Query the live registry and select the first unused `0.4.0-rc.N`.
2. Commit that exact version with the workflow and package changes in a focused PR.
3. Merge only after all required checks pass.
4. Create `contracts-v2-v<version>` at the exact canonical-main merge commit.
5. Recheck the registry guard, tag SHA, workflow SHA, and tarball digest.
6. Dispatch **Publish contracts-v2** from `main` with only the exact version input.

The workflow has no tag input. It accepts only `0.4.0-rc.N`, requires `workflow_dispatch`, canonical `main`, and the exact repository-controlled tag, then runs `npm publish --tag rc --provenance`. It has no PR-triggered publishing path and cannot publish a stable version or move `latest`.

## Release gates

The workflow performs an immutable Yarn install, clean compilation, repository and package tests, exact Base/Base Staging deployment-output/address/ABI agreement, canonical source ABI verification, `npm pack` digest inspection, and clean installation/import from the exact tarball. It preserves those exact bytes for the OIDC publish job.

After publication it verifies the immutable registry integrity and provenance, confirms `rc` points to the new version and `latest` is unchanged, downloads and inspects the registry tarball, and clean-installs both the exact version and `@rc`.

If npm accepts the version but a later verification fails, do not rerun publication. npm versions are immutable; repair through a new RC forward-fix unless evidence proves only the `rc` tag needs an interactive, 2FA-protected correction.
