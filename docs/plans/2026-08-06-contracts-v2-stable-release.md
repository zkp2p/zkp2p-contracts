# Contracts-v2 Stable Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **Review:** Internal reviewer ✅ | Codex CLI convergence ✅ (3 rounds)

**Goal:** Add the protected dual-channel release path, repair native ESM packaging, prepare `@zkp2p/contracts-v2@0.4.0`, and then publish that exact stable version through the repository's npm OIDC workflow.

**Architecture:** Keep one `workflow_dispatch` workflow and derive RC versus stable solely from the committed package version. Centralize pure release rules and provenance claim validation in a testable policy module, leave npm mutation in one OIDC-authorized job, and make every other job read-only. Repair ESM during generation, then prove every advertised runtime export from a clean installed tarball under Node 22.14.

**Tech Stack:** Node.js 22.14 and 24.15, npm 12.0.2, Yarn 4.9.1, TypeScript compiler API, Node test runner, Jest, GitHub Actions, npm trusted publishing, Sigstore/SLSA provenance, Foundry v1.7.1.

**Scope source:** `docs/superpowers/specs/2026-08-06-contracts-v2-stable-release-design.md`

**Execution constraints:** Use the current assigned checkout as required by this repository's `AGENTS.md`; do not create another worktree. Use `@zkp2p-contracts-publish` for release preparation and initiation. Do not create a release tag, dispatch publishing, or change npm/GitHub configuration until the preparation PR is merged and the exact release tuple receives separate approval.

---

### Execution setup: Put the approved planning commits on a focused branch

**Files:**
- Track/commit before implementation: `docs/superpowers/specs/2026-08-06-contracts-v2-stable-release-design.md`
- Force-track/commit before implementation: `docs/plans/2026-08-06-contracts-v2-stable-release.md`

**Planning handoff prerequisite (performed once before implementation approval)**

The planning agent must commit the reviewed design amendment and this ignored
plan before handing it to the implementation agent:

```bash
git add docs/superpowers/specs/2026-08-06-contracts-v2-stable-release-design.md
git add -f docs/plans/2026-08-06-contracts-v2-stable-release.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: plan contracts-v2 stable release"
```

Expected: exactly the design amendment and implementation plan are committed.
This prerequisite is documentation publication, not release implementation; it
does not push, configure environments, tag, dispatch, or publish.

**Step 1: Confirm the assigned checkout contains only the approved local spec/plan commits**

Run:

```bash
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git "+main:${canonical_main_ref}"
git merge-base --is-ancestor "$canonical_main_ref" HEAD
git ls-files --error-unmatch docs/superpowers/specs/2026-08-06-contracts-v2-stable-release-design.md
git ls-files --error-unmatch docs/plans/2026-08-06-contracts-v2-stable-release.md
git status --short --branch
git log --oneline "$canonical_main_ref"..HEAD
```

Expected: the working tree is clean and the only ahead commits are the approved design and this implementation plan.

**Step 2: Create the preparation branch in this checkout**

Run:

```bash
git switch -c codex/contracts-v2-stable-release
```

Expected: the current assigned checkout is on the focused preparation branch. Do not create another worktree and do not push yet.

---

### Task 1: Make release-channel and tag invariants testable

**Files:**
- Create: `scripts/lib/npm-pack-result.mjs`
- Create: `scripts/lib/npm-release-policy.mjs`
- Create: `scripts/npm-release.spec.mjs`
- Modify: `scripts/npm-release.mjs`
- Modify: `package.json`

**Step 1: Write the failing pure-policy tests**

Create `scripts/npm-release.spec.mjs` with Node test cases that import the new policy module and cover the only permitted mappings:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExpectedDistTags,
  postPublishDistTags,
  releaseRegistryExpectations,
  resolveReleasePolicy,
} from './lib/npm-release-policy.mjs';

test('resolves an RC from the committed release-line prerelease', () => {
  assert.deepEqual(
    resolveReleasePolicy({
      release: '0.4.0-rc.6',
      packageVersion: '0.4.0-rc.6',
      releaseLine: '0.4.0',
    }),
    { channel: 'rc', distTag: 'rc', environment: 'npm-publish-rc' },
  );
});

test('resolves the exact release line as stable', () => {
  assert.deepEqual(
    resolveReleasePolicy({
      release: '0.4.0',
      packageVersion: '0.4.0',
      releaseLine: '0.4.0',
    }),
    { channel: 'stable', distTag: 'latest', environment: 'npm-publish-stable' },
  );
});

for (const release of ['0.4.1', '0.4.0-beta.1', '0.4.0-rc.01', 'v0.4.0', '0.4.0+build']) {
  test(`rejects unsupported release shape ${release}`, () => {
    assert.throws(
      () => resolveReleasePolicy({ release, packageVersion: release, releaseLine: '0.4.0' }),
      /release must be exactly 0\.4\.0 or 0\.4\.0-rc\.N/,
    );
  });
}

test('rejects a release that differs from the package manifest', () => {
  assert.throws(
    () => resolveReleasePolicy({
      release: '0.4.0',
      packageVersion: '0.4.0-rc.5',
      releaseLine: '0.4.0',
    }),
    /does not match.*package version/,
  );
});

test('requires both committed dist-tag baselines before publication', () => {
  assert.doesNotThrow(() => assertExpectedDistTags(
    { latest: '0.3.0', rc: '0.4.0-rc.5' },
    { latest: '0.3.0', rc: '0.4.0-rc.5' },
  ));
  assert.throws(
    () => assertExpectedDistTags(
      { latest: '0.4.0', rc: '0.4.0-rc.5' },
      { latest: '0.3.0', rc: '0.4.0-rc.5' },
    ),
    /latest points to 0\.4\.0, expected 0\.3\.0/,
  );
  assert.throws(
    () => assertExpectedDistTags(
      { latest: '0.3.0', rc: '0.4.0-rc.6' },
      { latest: '0.3.0', rc: '0.4.0-rc.5' },
    ),
    /rc points to 0\.4\.0-rc\.6, expected 0\.4\.0-rc\.5/,
  );
});

test('changes only the selected tag after publication', () => {
  const baselines = { latest: '0.3.0', rc: '0.4.0-rc.5' };
  assert.deepEqual(postPublishDistTags('stable', '0.4.0', baselines), {
    latest: '0.4.0',
    rc: '0.4.0-rc.5',
  });
  assert.deepEqual(postPublishDistTags('rc', '0.4.0-rc.6', baselines), {
    latest: '0.3.0',
    rc: '0.4.0-rc.6',
  });
});

test('uses pre-release baselines normally and post-release state for recovery', () => {
  const baselines = { latest: '0.3.0', rc: '0.4.0-rc.5' };
  assert.deepEqual(
    releaseRegistryExpectations({
      channel: 'stable', release: '0.4.0', recovery: false, baselines,
    }),
    {
      guard: { latest: '0.3.0', rc: '0.4.0-rc.5' },
      verify: { latest: '0.4.0', rc: '0.4.0-rc.5' },
    },
  );
  assert.deepEqual(
    releaseRegistryExpectations({
      channel: 'stable', release: '0.4.0', recovery: true, baselines,
    }),
    {
      guard: { latest: '0.4.0', rc: '0.4.0-rc.5' },
      verify: { latest: '0.4.0', rc: '0.4.0-rc.5' },
    },
  );
});
```

Add a CLI integration test that writes a temporary package manifest and `GITHUB_OUTPUT`, then executes:

```js
execFileSync(process.execPath, ['scripts/npm-release.mjs', 'resolve', packageJsonPath, '0.4.0'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    RELEASE_LINE: '0.4.0',
    LATEST_BASELINE: '0.3.0',
    RC_BASELINE: '0.4.0-rc.5',
    RECOVERY_MODE: 'false',
    GITHUB_OUTPUT: outputPath,
  },
});
```

Parse the output file and require all seven fields: `channel`, `dist_tag`, `environment`, `guard_latest`, `guard_rc`, `verify_latest`, and `verify_rc`. Repeat with `RECOVERY_MODE=true` and assert recovery guard values equal postconditions. Reject missing `GITHUB_OUTPUT` in Actions and any `RECOVERY_MODE` value other than the exact strings `true` or `false`, including empty, `yes`, and `1`.

Add the new test file to the root release-policy command:

```json
"test:release-policy": "node --test scripts/verify-github-environment.spec.mjs scripts/npm-release.spec.mjs"
```

Add table-driven fixtures for both supported `npm pack --json` contracts: the
npm <=11 one-element array and the npm 12 object keyed by package name. Require
`normalizeNpmPackResult` to return exactly one
`@zkp2p/contracts-v2` result from either shape and reject empty, duplicate,
wrong-package, missing-filename, or unknown shapes. Add a CLI integration case
for `npm-release.mjs pack-path <pack.json> <pack-dir>` and require the resolved
path to stay inside the supplied pack directory.

**Step 2: Run the policy test and confirm the intended failure**

Run:

```bash
yarn test:release-policy
```

Expected: FAIL because `scripts/lib/npm-release-policy.mjs` does not exist.

**Step 3: Implement the minimal pure policy module**

Create `scripts/lib/npm-release-policy.mjs` with these exported contracts:

```js
const stableChannel = Object.freeze({
  channel: 'stable',
  distTag: 'latest',
  environment: 'npm-publish-stable',
});
const rcChannel = Object.freeze({
  channel: 'rc',
  distTag: 'rc',
  environment: 'npm-publish-rc',
});

export function resolveReleasePolicy({ release, packageVersion, releaseLine }) {
  if (packageVersion !== release) {
    throw new Error(`release input ${release} does not match package version ${packageVersion}`);
  }
  if (release === releaseLine) return { ...stableChannel };

  const escapedLine = releaseLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${escapedLine}-rc\\.(0|[1-9]\\d*)$`).test(release)) {
    return { ...rcChannel };
  }
  throw new Error(`release must be exactly ${releaseLine} or ${releaseLine}-rc.N`);
}

export function assertExpectedDistTags(actual, expected) {
  for (const tag of ['latest', 'rc']) {
    if (!expected[tag]) throw new Error(`expected ${tag} baseline is missing`);
    if (actual[tag] !== expected[tag]) {
      throw new Error(`${tag} points to ${actual[tag] || '<missing>'}, expected ${expected[tag]}`);
    }
  }
}

export function postPublishDistTags(channel, release, baselines) {
  if (channel === 'stable') return { ...baselines, latest: release };
  if (channel === 'rc') return { ...baselines, rc: release };
  throw new Error(`unsupported release channel ${channel}`);
}

export function releaseRegistryExpectations({ channel, release, recovery, baselines }) {
  const verify = postPublishDistTags(channel, release, baselines);
  return { guard: recovery ? verify : { ...baselines }, verify };
}
```

Create `scripts/lib/npm-pack-result.mjs` as the single parser for npm pack
metadata. npm 11 and earlier return a one-element array; npm 12 returns an
object keyed by package name. Normalize only those two known shapes, require
exactly one result for the expected package, and validate its `name`, `version`,
`filename`, `integrity`, and `shasum` strings. Never select `Object.values()[0]`
without checking the key and cardinality. Wire `pack-path` through this helper;
Task 4 will make the package verifier and workflow use the same parser.

Keep SemVer validation in `scripts/npm-release.mjs`, then call `resolveReleasePolicy` for every command. The exact resolver interface is `npm-release.mjs resolve <package.json> <version>`; it takes no operator-supplied channel/tag/environment. It writes `channel`, `dist_tag`, `environment`, `guard_latest`, `guard_rc`, `verify_latest`, and `verify_rc` to `GITHUB_OUTPUT` and prints the same values for local diagnostics. Compute those tag outputs with `releaseRegistryExpectations` and the repository-controlled `RELEASE_LINE`, `LATEST_BASELINE`, `RC_BASELINE`, and exact Boolean-string `RECOVERY_MODE`; recovery guards against already-published postconditions, not unpublished baselines. For `guard`, `recover`, and `verify`, recompute the policy and reject any supplied `DIST_TAG` or environment that differs from the resolver output.

**Step 4: Run policy tests until they pass**

Run:

```bash
yarn test:release-policy
```

Expected: PASS for both the existing environment tests and the new resolver/tag tests.

**Step 5: Commit the policy slice**

```bash
git add package.json scripts/lib/npm-pack-result.mjs scripts/lib/npm-release-policy.mjs scripts/npm-release.mjs scripts/npm-release.spec.mjs
git commit -m "feat: derive contracts release channel from version"
```

---

### Task 2: Enforce canonical Git source and cryptographically bound provenance

**Files:**
- Create: `scripts/fixtures/npm-audit-contracts-v2-0.4.0-rc.5.json`
- Modify: `scripts/lib/npm-release-policy.mjs`
- Modify: `scripts/npm-release.mjs`
- Modify: `scripts/npm-release.spec.mjs`

**Step 1: Add failing canonical-source tests**

Extend `scripts/npm-release.spec.mjs` with a temporary Git repository fixture. Initialize `main`, create `refs/remotes/zkp2p-canonical/main`, and test both tag forms:

```js
test('accepts only an annotated release tag at exact canonical main', () => {
  const fixture = createReleaseGitFixture({ tagKind: 'annotated' });
  assert.doesNotThrow(() => assertCanonicalReleaseSource({
    cwd: fixture.cwd,
    githubRepository: 'zkp2p/zkp2p-contracts',
    githubEventName: 'workflow_dispatch',
    githubRef: 'refs/heads/main',
    githubSha: fixture.sha,
    releaseTag: 'contracts-v2-v0.4.0',
    recovery: false,
  }));
});

test('rejects a lightweight release tag', () => {
  const fixture = createReleaseGitFixture({ tagKind: 'lightweight' });
  assert.throws(() => assertCanonicalReleaseSource({
    cwd: fixture.cwd,
    githubRepository: 'zkp2p/zkp2p-contracts',
    githubEventName: 'workflow_dispatch',
    githubRef: 'refs/heads/main',
    githubSha: fixture.sha,
    releaseTag: 'contracts-v2-v0.4.0',
    recovery: false,
  }), /must be an annotated tag object/);
});
```

Also test wrong repository, non-dispatch event, non-main ref, `HEAD != GITHUB_SHA`, canonical-main drift, tag drift, recovery ancestry, and recovery changes outside the exact allowlist from the approved design.

**Step 2: Add failing provenance-claim tests**

Capture the public RC5 audit result as
`scripts/fixtures/npm-audit-contracts-v2-0.4.0-rc.5.json`; tests must not call
the network. Acquire it under the exact attestation toolchain used by the
workflow:

```bash
repo_root=$PWD
fixture_tmp=$(mktemp -d)
cd "$fixture_tmp"
npx --yes --package=node@24.15.0 --package=npm@12.0.2 -- npm init --yes
npx --yes --package=node@24.15.0 --package=npm@12.0.2 -- npm install @zkp2p/contracts-v2@0.4.0-rc.5 --ignore-scripts --no-audit --no-fund
npx --yes --package=node@24.15.0 --package=npm@12.0.2 -- npm audit signatures --json --include-attestations > audit.json
cp audit.json "$repo_root/scripts/fixtures/npm-audit-contracts-v2-0.4.0-rc.5.json"
cd "$repo_root"
```

Before committing it, verify the subprocess reports Node `v24.15.0` and npm
`12.0.2`. The fixture contains public registry/Sigstore evidence only; do not
add npm config, cache paths, logs, headers, tokens, or environment data. Read
the checked-in fixture in `scripts/npm-release.spec.mjs`, assert its SHA-256
against a literal recorded after capture, and assert it contains exactly the
RC5 package `0.4.0-rc.5`, source SHA
`6f3199fc4c6154c9d2767e061a173870c758296d`, run `30861109551`, attempt `1`,
and environment `npm-publish-rc`. Add fixture builders around its verified
entry for mutation tests. The production CLI is what runs npm's cryptographic
verification before calling the same semantic assertion. The positive case
must bind all values:

```js
test('binds verified provenance to package, digest, source, run, and environment', () => {
  assert.doesNotThrow(() => assertVerifiedProvenance({
    auditReport: provenanceFixture(),
    packageName: '@zkp2p/contracts-v2',
    release: '0.4.0-rc.5',
    integrity: 'sha512-Abwj6fucYlElyEVwOSSTUQT2BDLEdV0NXTZ6vj8GlRU9idnyKnnEuWn+h37VMyELnk8Jp9Q9fVMfM06KLwtnfw==',
    githubSha: '6f3199fc4c6154c9d2767e061a173870c758296d',
    runId: '30861109551',
    runAttempt: '1',
    environment: 'npm-publish-rc',
  }));
});
```

Clone the positive case into one mutation test per protected claim: PURL name/version, SHA-512 subject digest, repository, workflow path, ref, Git commit, event, invocation run ID/attempt, certificate SAN, certificate OIDC issuer, and Fulcio GitHub environment extension `1.3.6.1.4.1.57264.1.23`. Each mutation must fail with a claim-specific error.

Add pure recovery-run fixtures for `assertOriginalPublishRun` before wiring any HTTP fetch:

```js
test('accepts the exact original successful publish run and attempt', () => {
  assert.doesNotThrow(() => assertOriginalPublishRun({
    run: originalRunFixture(),
    jobs: originalJobsFixture(),
    expectedRepository: 'zkp2p/zkp2p-contracts',
    expectedWorkflowPath: '.github/workflows/publish-contracts-v2.yml',
    expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
    expectedRunId: '123456789',
    expectedRunAttempt: '1',
  }));
});
```

Table-test malformed/non-numeric IDs, wrong run ID or attempt, wrong repository,
workflow path, event, or head SHA, and a missing/duplicate/failed/skipped
`Publish with npm OIDC` job. The original run fixture must model a successful
OIDC publish job followed by a failed `Verify published package` job, proving
that propagation-only failure remains recoverable. Also accept a successful
verification job, but reject a verification job that started before publication,
any failed/skipped publish job, and any non-skipped recovery job in the claimed
original attempt. Keep the GitHub fetch wrapper thin: fetch the run plus
`jobs?filter=all`, then pass the returned data to this pure assertion.

**Step 3: Run the focused tests and verify failure**

Run:

```bash
node --test scripts/npm-release.spec.mjs
```

Expected: FAIL because canonical-source and provenance assertions are not implemented.

**Step 4: Implement canonical source enforcement**

Export `assertCanonicalReleaseSource` from `scripts/lib/npm-release-policy.mjs`. It must use `git` argument arrays, not a shell, and require:

```text
GITHUB_REPOSITORY == zkp2p/zkp2p-contracts
GITHUB_EVENT_NAME == workflow_dispatch
GITHUB_REF == refs/heads/main
git rev-parse HEAD == GITHUB_SHA
git rev-parse refs/remotes/zkp2p-canonical/main == GITHUB_SHA
git cat-file -t RELEASE_TAG == tag
git rev-parse RELEASE_TAG^{commit} == GITHUB_SHA (normal publication)
```

For recovery only, permit an ancestor tag and diff `tagCommit..HEAD` against exactly:

```js
const allowedRecoveryChanges = new Set([
  '.agents/skills/zkp2p-contracts-publish/SKILL.md',
  '.github/workflows/publish-contracts-v2.yml',
  'NPM_RELEASE.md',
  'scripts/npm-release.mjs',
  'scripts/lib/npm-pack-result.mjs',
  'scripts/lib/npm-release-policy.mjs',
  'scripts/npm-release.spec.mjs',
  'scripts/lib/release-environment-policy.mjs',
  'scripts/verify-github-environment.mjs',
  'scripts/verify-github-environment.spec.mjs',
  'packages/contracts/scripts/verify-release.mjs',
  'packages/contracts/scripts/smoke-installed.mjs',
]);
```

These two new policy paths are deliberately non-package verification code and are also recorded in the approved design's recovery allowlist. They may repair a recovery verifier with its regression test but cannot change the original npm tarball.

Before calling the assertion in GitHub Actions, `scripts/npm-release.mjs` must fetch both refs explicitly:

```js
execFileSync('git', [
  'fetch', '--no-tags', 'https://github.com/zkp2p/zkp2p-contracts.git',
  '+main:refs/remotes/zkp2p-canonical/main',
]);
execFileSync('git', [
  'fetch', '--no-tags', 'https://github.com/zkp2p/zkp2p-contracts.git',
  `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`,
]);
```

Never inspect `origin/main` for a release decision.

**Step 5: Implement provenance verification around npm's verified bundle**

Add a `provenance` command to `scripts/npm-release.mjs`:

```text
npm-release.mjs provenance <package.json> <version> <pack.json> <consumer-directory>
```

The command must execute, with `cwd` set to the clean consumer directory:

```bash
npm audit signatures --json --include-attestations
```

Pin npm `12.0.2` only in publish/recovery jobs and run it on Node `24.15.0`, which satisfies npm 12's engine and exposes the cryptographically verified attestation bundles. Keep Node `22.14.0` for package build and ESM compatibility tests.

Select exactly one `verified` entry for `@zkp2p/contracts-v2@<release>` and exactly one SLSA v1 bundle. Decode its DSSE payload and assert:

```js
const expectedPurl = `pkg:npm/%40zkp2p/contracts-v2@${release}`;
const expectedWorkflow = {
  repository: 'https://github.com/zkp2p/zkp2p-contracts',
  path: '.github/workflows/publish-contracts-v2.yml',
  ref: 'refs/heads/main',
};
const expectedInvocation =
  `https://github.com/zkp2p/zkp2p-contracts/actions/runs/${runId}/attempts/${runAttempt}`;
```

Convert the validated `sha512-<base64>` integrity to lowercase hex and require it to equal `subject[0].digest.sha512`. Require the SLSA resolved dependency Git commit to equal the approved SHA. Use `node:crypto`'s `X509Certificate` for the exact GitHub workflow SAN. Add a small length-checked DER extension reader for the same certificate: require OID `1.3.6.1.4.1.57264.1.1` to contain the raw UTF-8 bytes `https://token.actions.githubusercontent.com`, and require OID `1.3.6.1.4.1.57264.1.23` to contain a DER UTF8String equal to the resolved environment. The reader must reject indefinite lengths, out-of-bounds lengths, duplicate OIDs, invalid UTF-8, a non-UTF8String environment value, or trailing bytes, and its malformed-DER cases must be unit-tested. Fail if the package entry, bundle, subject, or any identity claim is missing or duplicated.

For recovery, set the expected provenance SHA to
`git rev-parse "$RELEASE_TAG^{commit}"`, not the recovery run's newer
`GITHUB_SHA`. Query the GitHub Actions run and jobs APIs with `GITHUB_TOKEN` and
require the supplied original run to belong to this repository/workflow, use
`workflow_dispatch`, have that tagged release SHA as `head_sha`, and contain
exactly one successful `Publish with npm OIDC` job rather than a recovery job.
Permit its separate later `Verify published package` job to be successful or
failed, because a propagation failure there is the recovery trigger; use job
timestamps to require it started only after the successful publish job ended.
Require the provenance invocation ID to identify that original run/attempt. For
normal publication, require `GITHUB_SHA`, the current `GITHUB_RUN_ID`, and
`GITHUB_RUN_ATTEMPT`.

**Step 6: Run the release-policy tests**

Run:

```bash
yarn test:release-policy
```

Expected: PASS, including every provenance mutation and canonical-tag test.

**Step 7: Commit the trust-boundary slice**

```bash
git add scripts/fixtures/npm-audit-contracts-v2-0.4.0-rc.5.json scripts/lib/npm-release-policy.mjs scripts/npm-release.mjs scripts/npm-release.spec.mjs
git commit -m "fix: bind contract releases to canonical provenance"
```

---

### Task 3: Repair generated native ESM at the source boundary

**Files:**
- Create: `packages/contracts/test/buildModules.test.ts`
- Modify: `packages/contracts/scripts/build-modules.ts`
- Modify: `packages/contracts/scripts/extractors/paymentMethods.ts`

**Step 1: Add failing resolver and generated-output tests**

Refactor `buildModules` to accept an optional package-root argument (defaulting
to the real package root), export a pure
`resolveEsmSpecifier(specifier, importerPath)` helper, and export a pure
`renderPaymentMethodsIndex(networks)` helper from the payment-method extractor.
The test must create a temporary minimal package tree with a manifest and
representative `addresses`, `abis`, `paymentMethods`, `utils`, and types-only
sources, invoke the build against that temporary root, and inspect only the
temporary generated tree. It must never read ignored `_esm`, `_cjs`, or
generated source directories from the working checkout.

Add resolver tests for each source shape:

```ts
expect(resolveEsmSpecifier('./base.json', addressesIndex)).toBe('./base.js');
expect(resolveEsmSpecifier('./protocolUtils', utilsIndex)).toBe('./protocolUtils.js');
expect(resolveEsmSpecifier('./base', abisIndex)).toBe('./base/index.js');
expect(resolveEsmSpecifier('abitype', abisIndex)).toBe('abitype');
```

Add generated-tree assertions:

```ts
expect(JSON.parse(read('_esm/package.json'))).toEqual({ type: 'module' });
expect(read('_esm/index.js')).toContain('export const version = "0.4.0-rc.5";');
expect(read('_esm/index.js')).not.toContain('require(');

for (const file of allJavaScriptFiles('_esm')) {
  expect(read(file)).not.toMatch(/\brequire\s*\(/);
  expect(read(file)).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]+\.json['"]/);
  assertRelativeEsmSpecifiersResolve(file);
}

expect(allFiles('_esm')).not.toContainEqual(expect.stringMatching(/\.(?:cjs|mjs)$/));
expect(allFiles('_cjs')).not.toContainEqual(expect.stringMatching(/\.(?:cjs|mjs)$/));
```

The version expectation should read the temporary fixture's `package.json`
instead of hard-coding the string in the final test implementation.

Test `renderPaymentMethodsIndex(['base', 'baseStaging'])` directly and require
static imports plus an in-memory map, with no runtime `require`. The temporary
fixture's manifest version supplies the root-version assertion, so the test is
hermetic and does not depend on a previously run extraction/build.

**Step 2: Run the focused package test and verify failure**

Run:

```bash
yarn workspace @zkp2p/contracts-v2 test --runInBand --runTestsByPath test/buildModules.test.ts
```

Expected: FAIL because the injectable builder, resolver-aware rewriting, and
pure payment-method index renderer are not implemented. The failure must not be
caused by missing or stale ignored output in the checkout.

**Step 3: Add resolver-aware ESM specifier rewriting**

In `build-modules.ts`, thread the injected package root through every input and
output path, and remove `types` from the runtime `MODULES` list because
`./types` is types-only. Use a TypeScript `before` transformer only for ESM
output. Skip type-only imports/exports that TypeScript erases; for every
relative runtime static import/export and string-literal dynamic import:

1. Resolve from the importing source file.
2. Map an existing `.json` source to its generated `.js` companion.
3. Map an existing `.ts` source to `.js`.
4. Map an existing directory `index.ts` or `index.json` to `/index.js`.
5. Leave packages and already explicit `.js`/`.mjs` specifiers unchanged.
6. Throw when a relative runtime specifier cannot be resolved.

Pass the transformer to `ts.transpileModule` only for `ModuleKind.ESNext`; leave CommonJS transpilation unchanged.

**Step 4: Stop copying root wrapper files into compiled trees**

Remove the `entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')` copy branch from `build-modules.ts`. The root `abis/*.cjs`, `abis/*.mjs`, `networks/*.cjs`, and `networks/*.mjs` wrappers are already shipped directly and are the export-map targets. Copying them into both compiled trees creates cross-format junk and broken doubled `_esm/_esm` paths.

**Step 5: Remove generated ESM runtime `require` calls**

Change the `paymentMethods/index.ts` generator to call the exported pure renderer,
which emits static JSON imports and a typed in-memory map:

```ts
${networks.map((network) => `import ${network}Data from './${network}.json';`).join('\n')}

const paymentMethodsByNetwork: Record<string, NetworkPaymentMethods> = {
${networks.map((network) => `  ${network}: ${network}Data,`).join('\n')}
};

export function getPaymentMethodConfig(
  network: string,
  paymentMethod: string,
): PaymentMethodConfig | undefined {
  return paymentMethodsByNetwork[network]?.methods?.[paymentMethod];
}

export const paymentMethods = paymentMethodsByNetwork;
```

The ESM transformer will redirect those JSON imports to `.js` companions; CommonJS may continue loading the copied JSON files.

**Step 6: Generate module markers and literal versions**

Read the package manifest once in `buildMainIndex()` and emit:

```js
// _esm/index.js
export const version = "<JSON-serialized package version>";

// _cjs/index.js
exports.version = "<JSON-serialized package version>";
```

Also write `_esm/package.json` as exactly:

```json
{
  "type": "module"
}
```

**Step 7: Rebuild once and run the focused package tests**

Run:

```bash
yarn pkg:build
yarn workspace @zkp2p/contracts-v2 test --runInBand --runTestsByPath test/buildModules.test.ts test/paymentMethods.test.ts
```

Expected: PASS; `_esm` has no runtime `require`, raw JSON import, unresolved relative specifier, copied `.cjs`/`.mjs` wrapper, or generated `types` runtime subtree; `_cjs` likewise has no copied cross-format wrappers.

**Step 8: Commit the ESM generation slice**

Do not stage generated package output unless it is already tracked and changed by the canonical build. Stage the generator and tests explicitly:

```bash
git add packages/contracts/scripts/build-modules.ts packages/contracts/scripts/extractors/paymentMethods.ts packages/contracts/test/buildModules.test.ts
git commit -m "fix: generate Node-compatible contracts ESM"
```

---

### Task 4: Make the export map and installed smoke test exhaustive

**Files:**
- Modify: `scripts/lib/npm-pack-result.mjs`
- Modify: `scripts/npm-release.mjs`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/scripts/generate-abi-wrappers.ts`
- Modify: `packages/contracts/scripts/generate-network-entries.ts`
- Modify: `packages/contracts/scripts/verify-release.mjs`
- Modify: `packages/contracts/scripts/smoke-installed.mjs`
- Modify: `packages/contracts/test/buildModules.test.ts`
- Modify: `utils/protocolUtils.ts`

**Step 1: Add failing export-map tests**

Make `generateAbiWrappers` and `generateNetworkEntries` accept an optional
package-root argument, defaulting to the real package root, and thread it
through every manifest/generated-directory path. Extend the temporary fixture
from Task 3 with representative Base/Base Staging address, ABI, constants,
payment-method, currency, oracle-feed, network, utility, and types-only inputs.
Inside the test, invoke both generators and `buildModules` against that temporary
root before loading the fixture's `package.json#exports`; never inspect the
checkout's ignored generated outputs.

Assert:

```ts
expect(exports['./types']).toEqual({ types: './types/index.ts' });
expect(exports['./utils'].import).toBe('./_esm/utils/index.js');
expect(exports['./utils'].require).toBe('./_cjs/utils/index.js');
expect(exports['./utils/protocolUtils'].import).toBe('./_esm/utils/protocolUtils.js');
expect(exports['./utils/protocolUtils'].require).toBe('./_cjs/utils/protocolUtils.js');
expect(exports['./abis'].import).toBe('./_esm/abis/index.js');
expect(exports['./abis'].require).toBe('./_cjs/abis/index.js');
```

For every export object with `import`, `require`, or runtime `default`, assert
its target exists in the temporary generated tree and is JavaScript, not `.ts`.
Expand wildcard runtime targets against the fixture files and require at least
one concrete match. For raw string `*.json` exports, require the fixture target
files to exist and select at least one representative concrete public specifier
per wildcard family for import-attribute smoke coverage.

**Step 2: Run the focused test and verify failure**

Run:

```bash
yarn workspace @zkp2p/contracts-v2 test --runInBand --runTestsByPath test/buildModules.test.ts
```

Expected: FAIL because the ABI/network generators are not root-injectable,
`./utils` and `./abis` advertise TypeScript runtime targets, and `./types` has
an unintended runtime default path. The failure must not depend on a prior real
package build.

**Step 3: Fix generator-owned exports**

Update `generate-abi-wrappers.ts` so regenerated `package.json` preserves the package's exact root/subpath exports and writes aggregate ABI runtime targets to built JavaScript:

```json
"./abis": {
  "types": "./abis/index.ts",
  "import": "./_esm/abis/index.js",
  "require": "./_cjs/abis/index.js",
  "default": "./_esm/abis/index.js"
}
```

Keep `./types` types-only. Give `./utils` and `./utils/protocolUtils` explicit ESM/CJS targets while retaining their `.ts` source files only under the `types` condition. Ensure `generate-network-entries.ts` keeps the same export objects when it appends Base and Base Staging network entries.

Do not add a runtime export for a path that has no generated JavaScript.

**Step 4: Require the repaired files in tarball verification**

Add these to `requiredPackFiles` in `verify-release.mjs`:

```js
'_esm/package.json',
'_esm/index.js',
'_cjs/index.js',
'_esm/abis/index.js',
'_cjs/abis/index.js',
'_esm/utils/index.js',
'_cjs/utils/index.js',
```

Also validate that every runtime export target in the packed `package.json` exists in the pack file list, with wildcard targets expanded against packed files.

Import the shared `normalizeNpmPackResult` helper rather than indexing
`JSON.parse(...)[0]`. Extend the policy tests with realistic npm 11 array and
npm 12 keyed-object pack fixtures and prove that both `verify-release.mjs` and
the `pack-path` CLI resolve the same filename/integrity. Replace every workflow
inline `[0]` tarball extractor with `npm-release.mjs pack-path`.

**Step 5: Make protocol utilities compatible with both declared ethers peer majors**

Replace the v5-only `BigNumber` import and direct `ethers.utils` calls in `utils/protocolUtils.ts` with a small cross-version boundary. Keep the exported function names and hashes unchanged:

```ts
import * as ethersPackage from 'ethers';

type IntegerLike = string | number | bigint | { toString(): string };
const ethersApi = (ethersPackage as any).ethers ?? ethersPackage;
const ethersUtils = ethersApi.utils ?? ethersApi;
const circomField = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

export const getKeccak256Hash = (value: string): string =>
  ethersUtils.keccak256(ethersUtils.toUtf8Bytes(value));

export const calculateIntentHash = (
  orchestrator: string,
  intentCounter: IntegerLike,
): string => {
  const packedHash = (ethersApi.solidityPackedKeccak256 ?? ethersUtils.solidityKeccak256)(
    ['address', 'uint256'],
    [orchestrator, intentCounter.toString()],
  );
  const reduced = BigInt(packedHash) % circomField;
  const hexDigits = reduced.toString(16);
  const reducedHex = `0x${hexDigits.padStart(Math.ceil(hexDigits.length / 2) * 2, '0')}`;
  return ethersApi.zeroPadValue
    ? ethersApi.zeroPadValue(reducedHex, 32)
    : ethersUtils.hexZeroPad(reducedHex, 32);
};
```

Keep `Currency`, `getCurrencyCodeFromHash`, and `calculatePaymentMethodHash` implemented through the same resolved `ethersUtils`. This remains behavior-compatible with the repository's ethers v5 runtime while making the package's advertised `^5 || ^6` peer range true.

Add these deterministic utility vectors to the smoke consumer and require identical outputs under both peer majors:

```js
assert.equal(
  protocolUtils.getKeccak256Hash('USD'),
  '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e',
);
assert.equal(
  protocolUtils.calculateIntentHash('0x1111111111111111111111111111111111111111', 42),
  '0x028743bcc98696610f1bc7f8a8365f1174f5023a1e6b851616cfd70084cf3b86',
);
```

**Step 6: Rewrite the installed smoke harness around the consumer directory**

In `smoke-installed.mjs`:

1. Read the installed package's export map.
2. Collect every exact runtime object export.
3. Expand wildcard object exports to concrete installed JavaScript files.
4. Expand every raw string `*.json` export family to at least one representative concrete public specifier. Load each representative with native ESM `import(specifier, { with: { type: 'json' } })` and with CommonJS `require`.
5. Write one temporary `.mjs` consumer and one `.cjs` consumer inside `process.cwd()`.
6. Run both consumers with `process.execPath` and fail on any import error.

The ESM consumer must import through package specifiers, not repository-relative file URLs. Its raw JSON imports must use Node 22.14 import attributes; wrapper imports must not rely on raw JSON. Both consumers must assert the root `version`, aggregate contract ABI exports, Base/Base Staging network ABI/address exports, and utility functions. Preserve the existing nonzero address and nonempty ABI assertions.

Use a structured result from the child consumers, for example:

```js
const expectedRuntimeExports = collectRuntimeExports(packageJson.exports, installedPackageRoot);
const consumerConfig = {
  expectedVersion,
  expectedRuntimeExports,
  expectedJsonExports,
  expectedContracts: ['IntentGuardian', 'OrchestratorV3', 'WhitelistLifecycleHook'],
  expectedNetworks: ['base', 'baseStaging'],
};
```

**Step 7: Rebuild and run package verification**

Run:

```bash
yarn pkg:build
yarn pkg:test
yarn workspace @zkp2p/contracts-v2 verify:release
```

Expected: PASS and no executable `.ts` target in the export map.

**Step 8: Pack and smoke the exact local tarball with both peer majors**

Run:

```bash
release_pack_dir=$(mktemp -d)
pack_json="$release_pack_dir/pack.json"
(cd packages/contracts && npm pack --ignore-scripts --json --pack-destination "$release_pack_dir" > "$pack_json")
tarball=$(node scripts/npm-release.mjs pack-path "$pack_json" "$release_pack_dir")
release_version=$(node -p 'require("./packages/contracts/package.json").version')
repo_root=$PWD
for ethers_version in 5.8.0 6.17.0; do
  release_smoke_dir=$(mktemp -d)
  cd "$release_smoke_dir"
  npm init --yes
  npm install "$tarball" "ethers@$ethers_version" --ignore-scripts --no-audit --no-fund
  node "$repo_root/packages/contracts/scripts/smoke-installed.mjs" "$release_version"
  cd "$repo_root"
done
```

Expected: PASS for CommonJS and native ESM under local Node 22.14 with ethers
5.8.0 and 6.17.0. The tarball path is selected through the shared pack-result
normalizer rather than an npm-version-specific JSON shape or literal filename.

Carry the same pinned peer-major matrix into Task 5's workflow smoke wiring; do not rely on npm's default peer resolution.

**Step 9: Commit the export/smoke slice**

```bash
git add scripts/lib/npm-pack-result.mjs scripts/npm-release.mjs packages/contracts/package.json packages/contracts/scripts/generate-abi-wrappers.ts packages/contracts/scripts/generate-network-entries.ts packages/contracts/scripts/verify-release.mjs packages/contracts/scripts/smoke-installed.mjs packages/contracts/test/buildModules.test.ts utils/protocolUtils.ts
git commit -m "fix: verify every contracts package runtime export"
```

---

### Task 5: Wire one protected workflow to RC and stable channels

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish-contracts-v2.yml`
- Modify: `scripts/lib/npm-pack-result.mjs`
- Modify: `scripts/npm-release.mjs`
- Modify: `scripts/verify-github-environment.spec.mjs`
- Modify: `scripts/lib/release-environment-policy.mjs`
- Modify: `scripts/verify-github-environment.mjs`
- Modify: `scripts/npm-release.spec.mjs`

**Step 1: Add failing environment and workflow-shape tests**

Generalize the environment test to run the same acceptance case for both names:

```js
for (const environmentName of ['npm-publish-rc', 'npm-publish-stable']) {
  test(`accepts autonomous main-only ${environmentName}`, () => {
    assert.doesNotThrow(() =>
      assertReleaseEnvironment(validEnvironment(), environmentName, mainOnlyPolicy()),
    );
  });
}
```

Add a rejection case where the only policy is
`{ name: 'main', type: 'tag' }`; `assertReleaseEnvironment` must require exactly
one policy whose `name === 'main'` and `type === 'branch'`.

Change error expectations from `autonomous RC publishing` to `autonomous publishing`.

Add static workflow assertions to `npm-release.spec.mjs` for:

```text
one global npm-publish-contracts-v2 concurrency group
cancel-in-progress: false
one policy job invoking npm-release.mjs resolve
validate and foundry-tests both need policy
publish environment selected from needs.policy.outputs.environment
exactly one id-token: write occurrence, under publish
publish ends after the single npm publish mutation
verify-publish needs publish, has no id-token permission, and has no npm publish command
recover has no id-token permission and no npm publish command
direct npm publish uses --tag "$DIST_TAG"
no npm dist-tag command
LATEST_BASELINE=0.3.0 and RC_BASELINE=0.4.0-rc.5
explicit canonical GitHub URL/main/tag fetches
annotated-tag guard
final guard appears after tarball download/verification and before npm publish
both EXPECTED_LATEST and EXPECTED_RC are passed to verification
selected-tag smoke uses the resolved dist tag, not literal @rc/@latest
validated tarball artifact retention is exactly 30 days
all tarball selection uses the shared pack-path CLI, with no JSON [0] indexing
normal PR CI runs release verification, normalized pack inspection, and the Node 22.14 ethers 5/6 installed-smoke matrix
```

**Step 2: Run the release-policy test and verify failure**

Run:

```bash
yarn test:release-policy
```

Expected: FAIL on RC-only language and the hard-coded workflow.

**Step 3: Make environment policy channel-neutral**

Update `assertReleaseEnvironment` and its CLI success message to say
`autonomous publishing`. Preserve the fail-closed rules: no reviewer, no wait
timer, custom policies enabled, and exactly one policy with `type=branch` and
`name=main`.

**Step 4: Add the policy job and channel-neutral workflow inputs**

Keep a single `release` input and no channel input. Make the run name channel-neutral. Set repository-controlled globals:

```yaml
env:
  FOUNDRY_VERSION: v1.7.1
  PACKAGE_JSON: packages/contracts/package.json
  RELEASE_VERSION: ${{ inputs.release }}
  RELEASE_LINE: 0.4.0
  RELEASE_TAG: contracts-v2-v${{ inputs.release }}
  LATEST_BASELINE: 0.3.0
  RC_BASELINE: 0.4.0-rc.5
  NPM_CONFIG_PROVENANCE: "true"
  REQUIRE_PROVENANCE: "true"
  RECOVERY_MODE: ${{ inputs.recovery }}
```

Add this concrete policy-job shape, using the same pinned checkout/setup actions as the workflow:

```yaml
jobs:
  policy:
    name: Resolve release policy
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
    outputs:
      channel: ${{ steps.resolve.outputs.channel }}
      dist_tag: ${{ steps.resolve.outputs.dist_tag }}
      environment: ${{ steps.resolve.outputs.environment }}
      guard_latest: ${{ steps.resolve.outputs.guard_latest }}
      guard_rc: ${{ steps.resolve.outputs.guard_rc }}
      verify_latest: ${{ steps.resolve.outputs.verify_latest }}
      verify_rc: ${{ steps.resolve.outputs.verify_rc }}
    steps:
      - name: Checkout policy source
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
        with:
          fetch-depth: 1
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 22.14.0
          package-manager-cache: false
      - name: Resolve version-derived channel
        id: resolve
        run: node scripts/npm-release.mjs resolve "$PACKAGE_JSON" "$RELEASE_VERSION"

  validate:
    needs: policy

  foundry-tests:
    needs: policy

  publish:
    needs: [policy, validate, foundry-tests]
    if: inputs.recovery == false

  verify-publish:
    name: Verify published package
    needs: [policy, validate, foundry-tests, publish]
    if: inputs.recovery == false

  recover:
    needs: [policy, validate, foundry-tests]
    if: inputs.recovery == true
```

This dependency shape lets validation and Foundry run in parallel after policy,
makes every `needs.policy.outputs.*` reference valid, and separates registry
mutation from eventual-consistency verification. Set `DIST_TAG`,
`RELEASE_CHANNEL`, `RELEASE_ENVIRONMENT`, `GUARD_LATEST`, `GUARD_RC`,
`VERIFY_LATEST`, and `VERIFY_RC` from policy outputs in all downstream jobs.

**Step 5: Preserve build and Foundry gates while making registry checks symmetric**

In validation and Foundry guards, pass the resolved tag plus the policy job's guard expectations. For normal publication those are the two committed pre-release baselines; for recovery they are the channel's already-published postconditions. In validation, read `latest` and `rc`, require both resolved guard values, and expose both actual values as outputs. Keep the existing immutable install, compile, package build/test/verifier, pack, tarball smoke, pinned Foundry suite, cache key, and global concurrency unchanged.

Every local and registry `npm pack --json` result must pass through
`npm-release.mjs pack-path`, backed by `normalizeNpmPackResult`; remove the
workflow's inline `JSON.parse(...)[0]` extractors. Preserve the validated
tarball artifact with `retention-days: 30` and `compression-level: 0`. Add a
static policy assertion for that exact retention. The runbook must require an
artifact-list/download availability check on the original run before beginning
any recovery PR; if the artifact expired, recovery stops because a fresh build
is not byte-equivalent evidence.

Verify the selected GitHub environment using:

```yaml
- name: Require autonomous release environment
  env:
    GITHUB_TOKEN: ${{ github.token }}
  run: node scripts/verify-github-environment.mjs "$RELEASE_ENVIRONMENT"
```

**Step 6: Restrict OIDC and add the immediate pre-mutation guard**

Only `publish` gets:

```yaml
environment:
  name: ${{ needs.policy.outputs.environment }}
permissions:
  contents: read
  id-token: write
```

After downloading and verifying the original validated tarball, but immediately before `npm publish`, rerun `guard` with both `EXPECTED_LATEST=$LATEST_BASELINE` and `EXPECTED_RC=$RC_BASELINE`. Publish exactly once:

```bash
npm publish "$tarball" --access public --tag "$DIST_TAG" --provenance
```

Do not add `npm dist-tag` or a fallback publish.

The `Publish with npm OIDC` job must end successfully immediately after npm
accepts that command. Do not put registry propagation, provenance lookup, or
installed-package verification in the mutation job; otherwise a later
eventual-consistency failure would erase the successful publication evidence
that recovery needs.

**Step 7: Wire post-publish and recovery verification**

Run normal post-publish verification in the separate read-only
`verify-publish` job. Use Node `24.15.0` plus npm `12.0.2` for
`npm audit signatures --include-attestations`. After installation of the exact
registry version, invoke the new provenance command with current run identity
(normal) or original run identity (recovery). Then switch the job back to Node
`22.14.0` before running exact-version and selected-tag CJS/ESM consumer smokes.
For each exact-version and selected-tag spec, run the smoke with explicit
`ethers@5.8.0` and `ethers@6.17.0`; the validation job must run the same two-peer
matrix against the preserved local tarball.

Set postconditions from the policy job's `VERIFY_LATEST` and `VERIFY_RC` outputs:

```text
stable: EXPECTED_LATEST=<release>, EXPECTED_RC=<RC_BASELINE>
RC:     EXPECTED_LATEST=<LATEST_BASELINE>, EXPECTED_RC=<release>
```

Recovery must download the original validated artifact, compare its pack
integrity to npm, verify the original successful `Publish with npm OIDC` job
through the Actions API, omit OIDC permission, and never call `npm publish`.
The original run's later `Verify published package` job may be failed only after
the successful publish job ended. npm 12 keyed-object pack output and npm 11
array output must both traverse the same tested normalizer.

**Step 8: Put the release-grade package gate in normal PR CI**

Modify the existing `build-and-deploy` job in `.github/workflows/ci.yml` rather
than adding another full compile. Pin that job's Node setup to `22.14.0` while
leaving unrelated Foundry/coverage lanes on their existing toolchain. After its
existing compile and package build/test, add:

```text
yarn workspace @zkp2p/contracts-v2 verify:release
npm pack to a temporary directory and normalize it with npm-release.mjs pack-path
verify-release.mjs --pack-json/--pack-dir against that exact tarball
clean installed CJS/ESM smokes against the same tarball with ethers 5.8.0
clean installed CJS/ESM smokes against the same tarball with ethers 6.17.0
```

Keep `test:release-policy` before package construction and the existing
localhost deployment after these package gates. This makes pull-request CI,
not the post-tag publish workflow, the first authoritative execution of the
Node 22.14 native ESM and peer-major acceptance criteria.

**Step 9: Run focused workflow-policy tests**

Run:

```bash
yarn test:release-policy
```

Expected: PASS for resolver, environments, canonical source, provenance, concurrency, OIDC isolation, symmetric tags, and workflow ordering.

**Step 10: Commit the workflow slice**

```bash
git add .github/workflows/ci.yml .github/workflows/publish-contracts-v2.yml scripts/lib/npm-pack-result.mjs scripts/lib/release-environment-policy.mjs scripts/npm-release.mjs scripts/verify-github-environment.mjs scripts/verify-github-environment.spec.mjs scripts/npm-release.spec.mjs
git commit -m "feat: add protected stable contracts publishing"
```

---

### Task 6: Prepare stable package metadata and release documentation

**Files:**
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/README.md`
- Modify: `NPM_RELEASE.md`
- Modify: `.agents/skills/zkp2p-contracts-publish/SKILL.md`

**Step 1: Confirm the stable version and registry baselines are still available**

Run:

```bash
npm view @zkp2p/contracts-v2@0.4.0 version --json
npm view @zkp2p/contracts-v2 dist-tags --json
```

Expected: the exact-version query returns npm `E404`; dist-tags contain `latest=0.3.0` and `rc=0.4.0-rc.5`. Stop and revise the plan if any value has moved.

**Step 2: Change the committed candidate to stable**

Set only the package manifest version:

```json
"version": "0.4.0"
```

Rebuild so generated root CJS/ESM version literals are also `0.4.0`.

**Step 3: Update consumer documentation**

Change `packages/contracts/README.md` from an RC5 heading to stable `0.4.0`, describe it as the production release of the RC5 contract/address surface plus native Node ESM repair, and keep the canonical install command untagged. Correct any examples that point to unsupported subpaths discovered by the export-map smoke test.

**Step 4: Rewrite the runbook for both channels**

Update `NPM_RELEASE.md` to document:

```text
one trusted publisher: zkp2p/zkp2p-contracts + publish-contracts-v2.yml
the npm environment field omitted once, not changed per release
GitHub environments npm-publish-rc and npm-publish-stable
both environments autonomous, main-only, and secret-free
version-derived rc/latest selection
both registry baselines and immediate pre-publish recheck
annotated canonical tag and exact canonical-main freeze
Node/npm pins for build versus attestation verification
30-day validated-tarball retention and pre-recovery artifact availability check
stable and RC postconditions
verification-only recovery for either channel
repository-admin and npm package-owner/maintainer authority for one-time setup
GitHub API plus npm settings read-back evidence for every external field
```

Make clear that `id-token: write` is job-scoped workflow code and requires no manual configuration for each release.

**Step 5: Update the repository publishing skill**

Make `.agents/skills/zkp2p-contracts-publish/SKILL.md` channel-neutral. Require reading `RELEASE_LINE`, both tag baselines, resolved environment, current workflow pins, annotated tags, canonical URL/ref checks, native ESM installed smoke, and claim-bound provenance. Preserve the ban on local publishing and the separate exact approval before tag creation/dispatch.

**Step 6: Run formatting-only checks for the documentation slice**

Run:

```bash
git diff --check
rg -n "0\.4\.0-rc\.5|RC publishing|cannot publish a stable" packages/contracts/README.md NPM_RELEASE.md .agents/skills/zkp2p-contracts-publish/SKILL.md
```

Expected: `git diff --check` passes. Remaining `0.4.0-rc.5` references are only the deliberate `RC_BASELINE`/release-history statements; RC-only policy language is gone.

**Step 7: Commit the stable metadata slice**

```bash
git add packages/contracts/package.json packages/contracts/README.md NPM_RELEASE.md .agents/skills/zkp2p-contracts-publish/SKILL.md
git commit -m "chore: prepare contracts-v2 0.4.0"
```

---

### Task 7: Run the preparation preflight and open the focused PR

**Files:**
- Verify all files changed in Tasks 1-6
- Do not modify contract sources, deployments, generated addresses, or generated ABIs to force a pass

**Step 1: Inspect the exact preparation diff**

Run:

```bash
git status --short
git diff --stat refs/remotes/zkp2p-canonical/main...HEAD
git diff --check refs/remotes/zkp2p-canonical/main...HEAD
```

Expected: only release policy/workflow, package-generation/smoke, metadata, tests, docs, and the approved spec/plan are changed. Investigate any deployment or Solidity diff before continuing.

**Step 2: Match local release tooling where practical**

Run:

```bash
node --version
forge --version
```

Expected: Node is `v22.14.0` for local ESM evidence. Foundry should match `v1.7.1`; if it does not, record that Foundry parity is delegated to CI rather than changing local toolchains during the release preflight.

**Step 3: Run the repository-defined preparation preflight once**

Run in order, preserving warm caches:

```bash
yarn install --immutable
yarn compile
yarn pkg:build
yarn pkg:test
yarn workspace @zkp2p/contracts-v2 verify:release
yarn test:release-policy
(cd packages/contracts && npm pack --dry-run --ignore-scripts --json)
```

Expected: every command passes; the pack list contains `_esm/package.json`, JavaScript runtime targets, Base/Base Staging addresses/ABIs, and no forbidden material.

**Step 4: Clean-install and smoke the final stable tarball**

Create the real tarball into a temporary directory, resolve it through
`npm-release.mjs pack-path`, install it into separate clean temporary consumers
with `ethers@5.8.0` and `ethers@6.17.0`, and run
`smoke-installed.mjs 0.4.0` in each under Node 22.14. Run
`verify-release.mjs --pack-json ... --pack-dir ...` against the same tarball and
confirm the npm 12 keyed-object fixture and current npm 10/11 array-shaped local
result both remain covered by policy tests.

Expected: exact CJS and ESM versions are `0.4.0`; every advertised runtime ESM export loads; contract ABIs and production/staging addresses pass.

**Step 5: Do not duplicate the complete Foundry suite locally**

This preparation changes no Solidity behavior. Do not run `yarn test` or coverage locally when the exact PR commit receives the workflow's pinned complete Foundry result. The publishing workflow retains the authoritative full-suite gate.

**Step 6: Commit any deterministic generated metadata required by the build**

Inspect `git status` after the final build. If the build changed tracked, consumer-visible generated metadata solely because the stable version or ESM generator changed, stage only those exact files and commit:

```bash
git add \
  packages/contracts/networks/base.cjs \
  packages/contracts/networks/base.d.ts \
  packages/contracts/networks/base.mjs \
  packages/contracts/networks/baseStaging.cjs \
  packages/contracts/networks/baseStaging.d.ts \
  packages/contracts/networks/baseStaging.mjs
git commit -m "chore: refresh stable contracts package artifacts"
```

Commit only the listed files that actually changed; if none changed, skip this commit.

Do not commit timestamp-only churn and do not expand this release into timestamp-generator changes. Publication and recovery verify the one preserved validated tarball; recovery must always download that original artifact rather than expecting a later rebuild to be byte-identical.

**Step 7: Fetch/rebase once for handoff and re-run only invalidated gates**

Fetch canonical `main` through the explicit canonical URL/ref. If it moved, rebase the focused preparation branch, inspect conflicts, and rerun only tests/builds invalidated by the rebase. Do not create or move the release tag.

**Step 8: Push and open the focused preparation PR**

Use `@create-pr`. The PR body must state:

```text
prepares @zkp2p/contracts-v2@0.4.0 but does not publish it
adds stable/latest while preserving RC/rc
fixes native Node 22.14 ESM exports
keeps full Foundry as a publish/CI gate
requires two one-time external settings after merge
requires separate exact approval before annotated tag creation and dispatch
no contract deployment/address changes
```

Wait for current-head CI because this PR is the shipping gate. Require the
expanded Node 22.14 `build-and-deploy` job—including release verification,
normalized pack verification, both installed module formats, and ethers 5/6
smokes—plus release-policy checks and the exact commit's pinned complete
Foundry result to be green before merge.

**Step 9: Hand off or merge the green preparation PR explicitly**

Report the PR URL, exact head SHA, and green required checks. Ask for explicit merge approval unless the user has already given it for this exact PR. After approval, merge using the repository's permitted merge method (or wait for the user to merge), then fetch canonical `main` through the explicit URL and require the merged preparation commit to be an ancestor of `refs/remotes/zkp2p-canonical/main`.

Do not begin npm/GitHub one-time configuration while the preparation commit exists only on a branch or open PR.

---

### Task 8: Perform the one-time stable environment setup after merge

**Files:**
- Read only: `.github/workflows/publish-contracts-v2.yml`
- Read only: `NPM_RELEASE.md`
- External configuration: GitHub environment and npm trusted publisher

**Step 1: Resolve merged canonical main**

Run:

```bash
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git "+main:${canonical_main_ref}"
git rev-parse "$canonical_main_ref"
```

Expected: the resolved commit contains the merged stable preparation and has green current CI.

**Step 2: Create `npm-publish-stable` once in GitHub**

This step requires repository-administrator access (or a fine-grained token
with repository Administration write access). In GitHub, open
`zkp2p/zkp2p-contracts` -> Settings -> Environments -> New environment, create
`npm-publish-stable`, and configure exactly:

```text
required reviewers: none
wait timer: none
deployment branches: custom
allowed branch: main only
environment secrets/variables: none
```

With the administrator-authenticated `gh` session, read every field back:

```bash
gh api repos/zkp2p/zkp2p-contracts/environments/npm-publish-stable
gh api repos/zkp2p/zkp2p-contracts/environments/npm-publish-stable/deployment-branch-policies
test "$(gh api repos/zkp2p/zkp2p-contracts/environments/npm-publish-stable/secrets --jq .total_count)" = 0
test "$(gh api repos/zkp2p/zkp2p-contracts/environments/npm-publish-stable/variables --jq .total_count)" = 0
GITHUB_REPOSITORY=zkp2p/zkp2p-contracts \
GITHUB_TOKEN="$(gh auth token)" \
  node scripts/verify-github-environment.mjs npm-publish-stable
```

Require no protection rules, `wait_timer=0`, custom branch policies enabled,
protected-branch policies disabled, and exactly one deployment branch policy of
type `branch` named `main`. Save the API outputs as release-approval evidence;
do not put the administrator credential in the workflow.

**Step 3: Edit npm's single trusted publisher once**

This step requires npm package-owner or maintainer authority. Sign in to npm,
open `@zkp2p/contracts-v2` -> Settings -> Trusted Publisher, edit the existing
GitHub Actions publisher, and preserve:

```text
organization: zkp2p
repository: zkp2p-contracts
workflow filename: publish-contracts-v2.yml
allowed action: npm publish only
```

Remove only the optional environment name. Do not add a token and do not change this setting between RC and stable releases.

After saving, reopen the same Trusted Publisher entry and record read-back
evidence showing the exact organization, repository, workflow filename,
`npm publish` action restriction, and a blank/omitted environment. npm does not
expose this publisher identity through `npm view`; the authoritative read-back
is the authenticated package settings page. Do not infer success merely from a
save confirmation.

**Step 4: Verify the one-time setup before release approval**

Use the same four GitHub API reads for both `npm-publish-rc` and
`npm-publish-stable`, plus the reopened npm Trusted Publisher settings. Confirm
both GitHub environments are autonomous/main-only/secret-free and npm still
names the exact repository/workflow publisher with no environment claim. Stop
if any field differs; do not test the setup by publishing an extra version.

---

### Task 9: Create the annotated tag and publish stable after exact approval

**Files:**
- Read only: canonical merged release files
- External mutations after explicit approval: one annotated Git tag and one workflow dispatch

**Step 1: Freeze and recheck the exact release tuple**

Coordinate a short canonical-main merge freeze, then run:

```bash
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git "+main:${canonical_main_ref}"
release_sha=$(git rev-parse "$canonical_main_ref")
git show "$release_sha:packages/contracts/package.json"
npm view @zkp2p/contracts-v2@0.4.0 version --json
npm view @zkp2p/contracts-v2 dist-tags --json
```

Expected:

```text
version: 0.4.0 and unused
release line: 0.4.0
latest: 0.3.0
rc: 0.4.0-rc.5
dist-tag: latest
environment: npm-publish-stable
tag: contracts-v2-v0.4.0
workflow: publish-contracts-v2.yml from refs/heads/main
```

**Step 2: Present the immutable tuple for separate approval**

Report the exact version, canonical SHA, annotated tag name, `latest` tag, `npm-publish-stable` environment, workflow filename, current CI URL/results, and both npm baselines. Do not create the tag or dispatch until the user explicitly approves that tuple.

**Step 3: Create and push the annotated tag at the approved SHA**

After approval:

```bash
git tag -a contracts-v2-v0.4.0 "$release_sha" -m "@zkp2p/contracts-v2 v0.4.0"
git push https://github.com/zkp2p/zkp2p-contracts.git refs/tags/contracts-v2-v0.4.0
```

Immediately fetch it back through the canonical URL and require:

```bash
canonical_main_ref=refs/remotes/zkp2p-canonical/main
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git "+main:${canonical_main_ref}"
git fetch --no-tags https://github.com/zkp2p/zkp2p-contracts.git "+refs/tags/contracts-v2-v0.4.0:refs/tags/contracts-v2-v0.4.0"
test "$(git cat-file -t contracts-v2-v0.4.0)" = tag
test "$(git rev-parse contracts-v2-v0.4.0^{commit})" = "$release_sha"
test "$(git rev-parse "$canonical_main_ref")" = "$release_sha"
git show "$release_sha:packages/contracts/package.json" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.exit(JSON.parse(s).version==="0.4.0"?0:1))'
```

If any check fails or main moved, stop and obtain a new approval; never move the tag silently.

**Step 4: Recheck npm and dispatch once**

Repeat the two explicit canonical fetches and all tag/main/package checks from Step 3. Reconfirm stable `0.4.0` is unused, `latest=0.3.0`, and `rc=0.4.0-rc.5`, then dispatch exactly once from canonical `main`:

```bash
gh workflow run publish-contracts-v2.yml \
  --repo zkp2p/zkp2p-contracts \
  --ref main \
  -f release=0.4.0 \
  -f recovery=false
```

Omit `release_run_id` entirely for normal publication; do not send an empty placeholder. Capture the workflow run URL/ID returned by GitHub and verify its `headSha` equals `$release_sha` before waiting on it.

Do not rerun publication if npm accepts the immutable version and a later verification step fails.

**Step 5: Require all workflow gates and registry postconditions**

Wait for the current release run and require:

```text
policy resolver: stable/latest/npm-publish-stable
package build/test/release verifier: pass
pinned Foundry v1.7.1 complete suite: pass
final pre-mutation unused-version and dual-baseline guard: pass
OIDC publication with provenance: pass
read-only Verify published package job: pass (or recovery is required after an accepted publish)
npm exact version: 0.4.0
latest: 0.4.0
rc: unchanged at 0.4.0-rc.5
registry integrity: equals original validated tarball
verified SLSA subject digest/source/ref/SHA/event/run/environment: exact match
clean @0.4.0 and @latest CJS/ESM installs under Node 22.14: pass
```

**Step 6: Use recovery only for a propagation-only verification failure**

If npm accepted `0.4.0` but registry propagation caused a later verification failure, do not rerun publish. Follow `NPM_RELEASE.md`, prepare only an allowlisted verification fix if necessary, and dispatch recovery with the original publish run ID. Recovery must download the original tarball and has no `id-token: write` or publish command.

Before opening a recovery PR, query the original run's artifacts and require the
30-day `contracts-v2-release-candidate` artifact to be present and unexpired:

```bash
gh api repos/zkp2p/zkp2p-contracts/actions/runs/$release_run_id/artifacts \
  --jq '.artifacts[] | select(.name == "contracts-v2-release-candidate" and .expired == false) | .id'
```

If this yields no single artifact ID, stop. Do not rebuild a substitute tarball.

For content, integrity, provenance identity, or dist-tag disagreement, stop and investigate; do not mutate the immutable version or tags with an ad hoc credential.

**Step 7: Report the completed stable release**

Report the canonical SHA/tag, workflow URL, all gate conclusions, exact npm version and dist-tags, integrity/provenance result, clean CJS/ESM smoke result, and whether recovery was used. Include direct npm and workflow links.
