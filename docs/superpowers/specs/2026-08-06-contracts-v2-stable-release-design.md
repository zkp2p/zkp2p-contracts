# Contracts-v2 0.4.0 Stable Release Design

**Status:** Approved
**Date:** 2026-08-06
**Package:** `@zkp2p/contracts-v2`
**Release line:** `0.4.0`
**Review:** Codex and Claude converged after three rounds

## Goal

Add a protected, provenance-backed stable publication path for
`@zkp2p/contracts-v2@0.4.0` without weakening the existing RC path. The same
repository-controlled workflow must support both channels, select the channel
from the committed version, validate the exact canonical source, and publish a
single previously validated tarball through npm OIDC.

The preparation change also fixes the package's native Node ESM entrypoints so
the stable release does not promote the known RC5 ESM defects.

## Non-goals

- Do not publish `0.4.0`, create its release tag, or move npm tags in the
  preparation PR.
- Do not use local `npm publish`, `npm dist-tag`, an OTP, `NPM_TOKEN`, or another
  developer credential.
- Do not redeploy contracts or alter Base/Base Staging deployment data.
- Do not add reviewers or wait timers to either GitHub publishing environment.
- Do not change repository-wide `main` branch governance in this release PR.
- Do not clean up the stale `next`, `test`, or `dev` npm dist-tags.

## Current State

At design time:

- npm has `rc=0.4.0-rc.5` and `latest=0.3.0`;
- `0.4.0` is unused;
- `packages/contracts/package.json` is `0.4.0-rc.5`;
- `.github/workflows/publish-contracts-v2.yml` accepts only
  `0.4.0-rc.N` and publishes under `rc`;
- npm trusts that workflow only when it uses `npm-publish-rc`;
- GitHub has `npm-publish-rc`, but not `npm-publish-stable`;
- `main` prevents deletion and non-fast-forward updates, but does not currently
  require a PR review or status checks;
- generated ESM contains raw JSON, extensionless relative imports, and runtime
  `require` calls that fail under native Node 22.14.

The weak `main` protection is an inherited trust assumption. A user who can
write arbitrary workflow code to `main` can already use the authorized
workflow and `npm-publish-rc` environment to publish under any npm dist-tag;
the npm environment claim does not constrain npm tags. Stronger branch rules
are recommended as separate repository hardening, but are not a blocker for
the autonomous stable environment explicitly selected for this release.

## Chosen Trust Model

npm permits one trusted publisher per package. Keep
`publish-contracts-v2.yml` as that publisher's sole authorized workflow and
make two one-time external configuration changes before stable dispatch:

1. Create `npm-publish-stable` in GitHub with no reviewers, no wait timer, no
   secrets, and a custom deployment branch policy allowing exactly `main`.
2. Edit npm's trusted publisher entry to omit the environment name while
   retaining the exact organization, repository, workflow filename, and
   `npm publish` action restrictions.

The environment claim is optional in npm's trusted-publisher model. Omitting
it allows the one workflow to use either repository-controlled GitHub
environment while npm continues to verify the repository and workflow
identity. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

The preparation PR documents these external changes but does not perform them.
They must be completed and verified after the release code is merged and before
the exact stable workflow dispatch. The operator performing this setup needs
repository-administrator access for the GitHub environment and package-owner
or maintainer access for the npm trusted-publisher edit. GitHub settings are
read back through the environment, deployment-policy, secret-list, and
variable-list APIs; npm's repository, workflow, action, and omitted-environment
fields are read back in the package's Trusted Publisher settings before release
approval. This is one-time setup, not a per-release operation.

## Version-derived Release Policy

The workflow must not accept a separate channel input. A single authoritative
resolver in `scripts/npm-release.mjs` derives the channel from the exact
committed version and the workflow's current `RELEASE_LINE`:

| Candidate | Channel | npm dist-tag | GitHub environment |
| --- | --- | --- | --- |
| `${RELEASE_LINE}-rc.N` | RC | `rc` | `npm-publish-rc` |
| `${RELEASE_LINE}` | Stable | `latest` | `npm-publish-stable` |

For this release, `RELEASE_LINE=0.4.0`. Any other SemVer shape fails closed.
The resolver also requires the candidate to equal the package manifest version.

A lightweight `policy` job invokes this resolver and exposes the resolved
channel, dist-tag, and environment as job outputs. The package-validation and
Foundry jobs depend on `policy` but continue to run in parallel. Publish and
recovery consume the same outputs. The run name is channel-neutral, and all
selected-tag smoke installs use the resolved dist-tag rather than a literal
`@rc` or `@latest`.

This creates one mapping source without adding a second operator-controlled
value that could disagree with the version.

## Workflow Shape

```text
workflow_dispatch on refs/heads/main
                 |
                 v
          policy / resolver
             /         \
            v           v
   package validation   pinned Foundry suite
             \         /
              v       v
        publish OR recovery
             |
             v
   read-only published-package verification
```

The workflow preserves its existing global concurrency group,
`npm-publish-contracts-v2`, with `cancel-in-progress: false`. RC, stable, and
recovery runs therefore serialize across the whole workflow. Two runs cannot
both validate the same npm pre-state and race their registry mutations.

Workflow concurrency does not serialize external npm maintainers or other
registry clients. After downloading and verifying the validated tarball, the
publish job must therefore re-run the unpublished-version guard and re-read
both channel-specific dist-tag baselines immediately before `npm publish`.
Any drift from the state approved for the release stops before registry
mutation. Post-publish verification remains necessary, but is not a substitute
for this final pre-mutation check.

Only the normal publish job receives `id-token: write`. Validation, policy,
Foundry, and recovery receive no npm publication authority. The publish job
selects its GitHub environment from the resolver output.

The OIDC publish job ends after the final registry guard and the single
successful `npm publish`. Post-publish metadata, integrity, provenance, and
installed-package checks run in a separate read-only job that needs the publish
job. This distinction is required for recovery: npm can accept the immutable
version while eventual registry propagation makes the later verification job
fail. Recovery proves that the original publish job succeeded and may tolerate
a failed read-only verification job; it never treats a failed mutation job as
proof of publication.

Both channels perform one direct tagged publication:

```sh
npm publish "$tarball" --access public --tag "$DIST_TAG" --provenance
```

RC therefore publishes atomically under `rc`, and stable publishes atomically
under `latest`. Neither path default-publishes or runs `npm dist-tag`.

## Canonical Source and Tag Requirements

The workflow must first require `GITHUB_REPOSITORY=zkp2p/zkp2p-contracts` and
resolve release source through the canonical URL rather than trusting the
checkout's configured `origin`:

```sh
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git \
  '+main:refs/remotes/zkp2p-canonical/main'
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git \
  "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
```

The release guard must then require all of the following:

- `GITHUB_EVENT_NAME=workflow_dispatch`;
- `GITHUB_REF=refs/heads/main`;
- checked-out `HEAD == GITHUB_SHA`;
- `refs/remotes/zkp2p-canonical/main == GITHUB_SHA`;
- the tag fetched from the canonical repository resolves to `GITHUB_SHA`;
- the release ref is an annotated tag object, proven with `git cat-file -t`;
- the package version and workflow release line match the resolver result.

The exact tip-of-main requirement remains intentional. An ancestor commit is
not eligible for normal publication, even if its release tag still resolves.

The release runbook must coordinate a short merge freeze and repeat canonical
main, package-version, tag, and registry checks immediately before tag creation
and immediately before dispatch. If `main` moves, stop and obtain approval for
a new exact tuple. Do not silently accept an ancestor or move an existing tag.

## Registry Preconditions and Postconditions

The workflow reads both `latest` and `rc`. Each preparation PR commits the
approved pre-release values as repository-controlled `LATEST_BASELINE` and
`RC_BASELINE` policy. The stable `0.4.0` preparation uses
`latest=0.3.0` and `rc=0.4.0-rc.5`.

| Mode | Required before | Required after |
| --- | --- | --- |
| Normal RC | version unused; `latest=<LATEST_BASELINE>`; `rc=<RC_BASELINE>` | `rc=<release>`; `latest=<LATEST_BASELINE>` |
| Normal stable | version unused; `latest=0.3.0`; `rc=0.4.0-rc.5` | `latest=0.4.0`; `rc=0.4.0-rc.5` |
| RC recovery | version exists; `rc=<release>`; `latest=0.3.0` | same |
| Stable recovery | version exists; `latest=0.4.0`; `rc=0.4.0-rc.5` | same |

`scripts/npm-release.mjs verify` must support explicit `EXPECTED_LATEST` and
`EXPECTED_RC` invariants. It first requires the selected dist-tag to point to
the release, then independently checks every supplied expected tag, registry
integrity, and provenance. The publish job repeats the version-unused and
expected-tag checks immediately before mutation, after all long-running build,
Foundry, artifact-download, and tarball-validation work has completed.

npm 12 emits `npm pack --json` as an object keyed by package name, while npm 11
and earlier emit an array. A shared, fail-closed parser accepts exactly those
two known shapes, selects exactly one result for `@zkp2p/contracts-v2`, and is
used by release policy, workflow tarball selection, and pack verification. Its
fixtures cover both shapes so the npm 12 attestation toolchain cannot silently
break tarball verification after publication.

For RC, the pre-mutation guard requires both committed tag baselines unchanged,
and the post-publish expectations are `rc=<release>` and
`latest=<LATEST_BASELINE>`. For stable, the pre-mutation guard likewise requires
both committed baselines, and the post-publish expectations are
`latest=<release>` and `rc=<RC_BASELINE>`. The exact version and the resolved
dist-tag are both clean-installed from the registry after publication or during
recovery.

## Stable Package Metadata

The preparation PR changes the package candidate from `0.4.0-rc.5` to
`0.4.0`. Consumer-facing package documentation and the release runbook must use
the same stable version and canonical repository URL.

Generated package data remains derived from the checked-in Base and Base
Staging deployment artifacts and outputs. The existing release verifier remains
responsible for proving exact address and ABI agreement before a tarball can be
published.

## Native ESM Repair

The current `_esm/index.js` contains CommonJS `require('../package.json')`, and
the package emits ESM syntax into `_esm/*.js` without marking that subtree as
ESM. Generated modules also retain raw JSON imports, extensionless relative
imports, and runtime `require` calls. Adding only a module marker would still
leave Base/Base Staging network imports failing with errors such as
`ERR_IMPORT_ATTRIBUTE_MISSING`.

The stable package repairs the complete advertised runtime ESM boundary:

1. `build-modules.ts` reads `package.json` and embeds a JSON-serialized version
   literal in the generated root entrypoints. The ESM root never calls
   `require`.
2. The build generates `_esm/package.json` containing `{ "type": "module" }`.
   Node therefore interprets `_esm/*.js` as ESM without changing `_cjs`.
3. The ESM build resolves every relative source specifier and emits an explicit
   Node-compatible target. JSON imports point to the generated `.js` companion
   modules, TypeScript imports use explicit `.js` paths, and directory imports
   resolve to explicit `index.js` paths. This must be resolver-aware rather than
   a blind textual suffix replacement.
4. ESM generators, including network and ABI wrappers, reference the repaired
   JavaScript wrappers instead of raw JSON. Generated ESM contains no runtime
   `require` calls.
5. The package export map is audited as part of the build. Every entry that
   advertises an `import` or runtime `default` target must resolve in native
   Node 22.14. Type-only entries must not advertise an executable TypeScript
   file as a runtime target. Runtime utilities receive generated ESM/CJS
   targets; aggregate ABI exports receive generated runtime wrappers or are
   explicitly classified as types-only.
6. Tarball verification requires `_esm/package.json`, `_esm/index.js`, and
   `_cjs/index.js`.

The installed-package smoke test must exercise the package through its export
map from a clean consumer installation. Because ESM resolution is relative to
the importing module, the smoke harness should execute a native ESM consumer
from the temporary install directory rather than import the package from the
repository script's own location.

The smoke test derives its runtime matrix from `package.json#exports`, expands
wildcards to representative packaged entries, and tests every supported exact
runtime ESM export. Raw `*.json` exports remain raw data paths and require the
consumer's standard JSON import attributes; JavaScript wrapper exports must not
depend on raw JSON loading.

At minimum, the runtime matrix includes the root, addresses, constants,
payment methods, currencies, oracle feeds, Base/Base Staging ABI wrappers,
canonical contract ABI wrappers, aggregate ABI entrypoint (if retained as
runtime), Base/Base Staging network bundles, and runtime utilities.

The smoke test asserts:

- installed `package.json.version` equals the expected version;
- CommonJS root `version` equals the expected version;
- ESM root `version` equals the expected version;
- CommonJS and ESM imports work for the root, contract ABI bundle, and Base and
  Base Staging network bundles;
- expected contract ABI exports are non-empty;
- expected deployment addresses are valid and nonzero.

The ESM checks run under the workflow-pinned Node 22.14 runtime so a package
cannot pass by relying on a newer or experimental module-resolution behavior.

## Provenance Verification

An attestation URL is not sufficient evidence. After publication and during
recovery, the workflow must fetch and cryptographically verify the npm/Sigstore
attestation bundle for the exact package version, then validate the SLSA v1
statement claims:

- the subject package name and version equal the requested release;
- the subject SHA-512 digest equals the validated tarball and registry
  integrity;
- the repository is exactly `https://github.com/zkp2p/zkp2p-contracts`;
- the workflow path is exactly
  `.github/workflows/publish-contracts-v2.yml`;
- the ref is exactly `refs/heads/main`;
- the resolved Git commit equals the approved `GITHUB_SHA`;
- the event is `workflow_dispatch`;
- the invocation ID identifies the expected GitHub run and attempt;
- the GitHub environment equals the resolved publish environment.

Normal verification expects the current publish run ID. Recovery expects the
supplied original `release_run_id`, and uses GitHub `actions: read` data to
prove that run was a non-recovery workflow dispatch for the same release and
head SHA, and contained exactly one successful OIDC publish job. The original
run's separate read-only verification job may have failed only after publication;
any failed or skipped publish job is rejected. This ties the registry artifact
to the exact original run whose validated tarball recovery downloads.

Provenance claim tests use a checked-in public RC5 audit fixture captured with
the pinned npm/Node attestation toolchain. The fixture records its exact package,
source SHA, workflow run and attempt, environment, and a fixed file digest; unit
tests never depend on a live network response.

## Recovery

Recovery remains verification-only. It must:

- require the exact immutable version to exist;
- receive the numeric original non-recovery publish run ID;
- require the original annotated release tag to be an ancestor of canonical
  `main`;
- download the original run's validated tarball;
- compare registry integrity to that original artifact;
- cryptographically verify provenance and bind it to that original run;
- re-run release, install, ABI, address, CJS, and ESM checks;
- omit `id-token: write` and never execute `npm publish`.

The validated tarball artifact is retained for 30 days. Recovery documentation
requires checking that the original run artifact is still available before
starting a recovery PR. Expired artifacts cannot be reconstructed because
generated metadata is not byte-stable; after expiry, stop rather than treating
a fresh rebuild as the accepted tarball.

The recovery allowlist may include only release-procedure and non-published
verification code:

- `.agents/skills/zkp2p-contracts-publish/SKILL.md`;
- `.github/workflows/publish-contracts-v2.yml`;
- `NPM_RELEASE.md`;
- `scripts/npm-release.mjs`;
- `scripts/lib/npm-pack-result.mjs`;
- `scripts/lib/npm-release-policy.mjs`;
- `scripts/npm-release.spec.mjs`;
- `scripts/lib/release-environment-policy.mjs`;
- `scripts/verify-github-environment.mjs`;
- `scripts/verify-github-environment.spec.mjs`;
- `packages/contracts/scripts/verify-release.mjs`;
- `packages/contracts/scripts/smoke-installed.mjs`.

Build generators, the package manifest, package sources, generated ABIs and
addresses, deployment artifacts, and deployment outputs remain forbidden after
the tag. Any change that can alter package contents requires a new forward-fix
version.

The release-policy module and its test are non-package verification code. They
are allowlisted so a propagation-only recovery can correct a verifier defect
with its regression test; neither path is included in the npm tarball or can
alter the preserved validated artifact.

## Environment Policy

The GitHub environment verifier remains fail-closed and accepts only an
autonomous environment with:

- no reviewer rule;
- no wait timer;
- custom deployment-branch policies enabled;
- exactly one allowed policy with `type=branch` and `name=main`.

RC-specific error text becomes channel-neutral, and policy tests cover both
`npm-publish-rc` and `npm-publish-stable`.

## Verification Strategy

Implementation follows test-first release-policy changes:

1. Add failing policy tests for stable resolution, RC resolution, rejected
   versions, stable environment policy, annotated tags, main-only dispatch,
   symmetric tag invariants, direct resolved-tag publishing, and preserved
   workflow concurrency.
2. Add failing policy checks for the canonical repository URL/ref, the final
   pre-mutation registry guard, and exact provenance identity/digest/run claims.
3. Add failing installed-package checks reproducing the root, raw-JSON,
   extensionless-specifier, runtime-`require`, and network ESM failures. Cover
   every advertised runtime ESM export and assert version equality. Generator
   unit tests build a temporary package fixture and never inspect ignored output
   left in the working tree.
4. Implement only enough release and package-generation behavior to make those
   regressions pass.

The final preparation preflight is:

```sh
yarn install --immutable
yarn compile
yarn pkg:build
yarn pkg:test
yarn workspace @zkp2p/contracts-v2 verify:release
yarn test:release-policy
(cd packages/contracts && npm pack --dry-run --ignore-scripts --json)
```

The packed tarball must also be clean-installed and smoked in both module
formats. The release workflow retains the complete Foundry suite using the same
pinned Foundry version as CI. A complete local Foundry rerun is unnecessary
when the exact commit is green in current CI because this change does not alter
Solidity behavior.

Before merge, the normal PR CI package/deployment job runs the package portion
under Node 22.14 and includes release verification, normalized pack inspection,
native installed CJS/ESM smokes, and the pinned ethers 5 and 6 peer matrix. The
publish workflow remains the final full Foundry and OIDC gate, but it is not the
first place the release-grade package acceptance criteria execute.

## Preparation and Release Sequence

### Preparation PR

1. Update release-policy tests first and observe the intended failures.
2. Implement the resolver, dual-channel workflow, symmetric registry checks,
   environment policy, stable version metadata, and ESM repair.
3. Update `NPM_RELEASE.md`, the publishing skill, and consumer-facing package
   documentation.
4. Run the focused local preflight and open a focused PR.
5. Merge only after required CI is green.

### One-time external setup

1. With repository-admin authority, create and verify `npm-publish-stable` as
   autonomous, main-only, and free of environment secrets or variables.
2. Remove the environment claim from npm's existing trusted publisher while
   signed in as a package owner or maintainer, preserving all other identity and
   action constraints, then read every field back in npm package settings.
3. Confirm no reusable npm credential is present in either environment and
   record the GitHub API and npm settings read-back evidence.

### Stable initiation

1. Fetch canonical `main` and resolve its exact SHA.
2. Confirm package `0.4.0`, release line `0.4.0`, `latest=0.3.0`,
   `rc=0.4.0-rc.5`, and unused stable `0.4.0`.
3. Present the exact version, commit, annotated tag, dist-tag, environment, and
   workflow dispatch for explicit approval.
4. After approval, create the annotated `contracts-v2-v0.4.0` tag at that exact
   SHA.
5. Recheck canonical `main`, the tag target/type, package metadata, registry
   baselines, and workflow policy.
6. Dispatch from `main` with recovery disabled.
7. Require the publish job to recheck the unused version and both npm tag
   baselines immediately before registry mutation.
8. Verify workflow gates, npm metadata, integrity, provenance identity,
   provenance digest/run binding, `latest`,
   unchanged `rc`, and clean exact/`@latest` CJS and ESM installs.

If any approved value changes before dispatch, stop and obtain new approval.

## Rejected Alternatives

- **One generic GitHub environment:** simpler naming, but loses useful RC/stable
  separation.
- **Stable-only trusted publisher:** makes future RC releases require another
  npm trust reconfiguration.
- **Separate channel input:** exposes a second operator-controlled value that
  can disagree with the package version.
- **Ancestor-tolerant normal publishing:** violates the exact canonical-main
  release-source requirement.
- **Build-generator changes during recovery:** can alter package contents after
  the immutable tag and must remain a forward-fix release.
- **Required stable reviewer:** explicitly declined; both environments remain
  autonomous.

## Acceptance Criteria

- The committed package candidate is exactly `0.4.0` and unused on npm.
- One resolver maps the version to the only permitted channel/environment pair.
- RC and stable runs share one serialized trusted workflow and publish directly
  under their resolved tags.
- Only normal publication receives OIDC write permission.
- OIDC mutation and read-only post-publish verification are separate jobs, so
  recovery can prove npm accepted a version even when propagation checks fail.
- Normal publishing requires workflow dispatch from the exact canonical-main
  commit, resolved through the explicit canonical URL/ref, and an annotated
  matching canonical tag.
- The publish job rechecks version availability and both npm tag baselines
  immediately before mutation.
- Stable publication moves only `latest`; RC remains pinned at
  `0.4.0-rc.5`.
- RC publication moves only `rc`; `latest` remains on its configured baseline.
- Registry integrity and provenance match the validated tarball.
- Provenance cryptographically binds the tarball digest, canonical
  repository/workflow/ref/SHA, selected environment, and expected run ID.
- Clean exact and selected-tag installations pass in CommonJS and native ESM,
  and every advertised runtime ESM export resolves under Node 22.14.
- Recovery can verify propagation-only failures without publication authority
  and cannot accept package-content drift.
- The preparation PR performs no release tag creation or npm mutation.

## Convergence Record

Codex and Claude converged after three review rounds. The design incorporated
symmetric dist-tag invariants, a single resolver, annotated-tag enforcement,
explicit exported-version smoke checks, channel-neutral environment policy,
preserved global concurrency, direct tagged publication for both channels, and
an explicit `refs/heads/main` guard.

The review accepted the live weak-`main` posture as an inherited, documented
risk rather than a new stable-release capability. Stronger branch protection
was deferred to separate repository governance. Ancestor-tolerant releases, a
second channel input, and build-generator recovery changes were rejected to
preserve the fail-closed and immutable-release boundaries.

An independent spec review then tightened four implementation boundaries: all
advertised runtime ESM exports must resolve under Node 22.14; registry
preconditions must be rechecked immediately before mutation; canonical source
must be fetched through the explicit canonical URL/ref; and provenance must be
cryptographically bound to the tarball, source identity, and expected workflow
run rather than checked only for URL presence.
