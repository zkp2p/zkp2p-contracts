# Trusted publishing for `@zkp2p/contracts-v2`

The only supported release path is `.github/workflows/publish-contracts-v2.yml`. It publishes with GitHub Actions OIDC, npm provenance, and no `NPM_TOKEN`.

## One-time npm configuration

On the npm settings page for `@zkp2p/contracts-v2`, add a GitHub Actions trusted publisher with these exact values:

| Field | Value |
| --- | --- |
| Organization | `zkp2p` |
| Repository | `zkp2p-contracts` |
| Workflow filename | `publish-contracts-v2.yml` |
| Environment | `npm-publish` |
| Allowed action | `npm publish` only |

The repository and workflow values are case-sensitive. Keep the environment value: the publish job always uses it, and npm includes it in the OIDC identity.

After one successful trusted publish, change npm **Publishing access** to **Require two-factor authentication and disallow tokens**, then revoke obsolete automation tokens. Configure trusted publishing first so a typo cannot lock out releases.

## One-time GitHub configuration

Create the `npm-publish` environment in `zkp2p/zkp2p-contracts` with:

- Sachin or the release-maintainer team as required reviewer.
- **Prevent self-review** enabled.
- Deployment branches restricted to protected `main` only.
- Administrator bypass disabled.
- No environment secrets; in particular, no `NPM_TOKEN`.

Protect `main` so releases can only use reviewed commits. The workflow itself has `contents: read`; only its approved publish job receives `id-token: write`.

The validation job checks these environment settings through the read-only GitHub API and fails before building if required reviewers, self-review prevention, disabled administrator bypass, or the `main` deployment restriction are missing.

At the time this workflow was added, the environment and `main` branch protection were not configured. The workflow intentionally remains fail-closed until both settings exist.

## Preparing a release

1. Change `packages/contracts/package.json` in a reviewed PR. Use a prerelease version for `dev` or `rc`, or a stable version for `latest`.
2. Update the package README/changelog for consumer-visible changes.
3. Merge the PR to `main` and wait for normal CI.
4. Dispatch **Publish contracts-v2** from `main`. Enter the exact committed version as `release` and choose `dev`, `rc`, or `latest` as `tag`.
5. Review the completed build/test/pack job, then approve the `npm-publish` environment. The initiator cannot approve their own run.

The workflow refuses non-`main` refs, mismatched versions, duplicate registry versions, prerelease versions tagged `latest`, and stable versions tagged `dev`/`rc`. Stable promotion therefore requires a version PR; do not move `latest` to an RC with `npm dist-tag`.

## Release gates

The workflow performs an immutable Yarn install, clean contract compilation, package build/tests, Base/Base Staging ABI and address-to-deployment integrity checks, and an exact `npm pack` manifest/integrity check. It uploads that checked tarball for the protected publish job, publishes the same bytes with provenance, and then verifies registry version, dist-tag, integrity, and package contents.

The release gate derives ABI/address requirements from the current generated package and deployment artifacts. It does not retain compatibility checks for contracts removed by a hard cut.

If publishing succeeds but post-publish verification times out, do not rerun blindly: npm versions are immutable and the duplicate-version guard will stop the rerun. Inspect the registry version and dist-tag, then repair only the tag with an interactive, 2FA-authenticated maintainer action if necessary.
