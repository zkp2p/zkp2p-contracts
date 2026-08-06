import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertCanonicalReleaseSource,
  assertExpectedDistTags,
  assertOriginalPublishRun,
  assertVerifiedProvenance,
  readDerExtensions,
  postPublishDistTags,
  releaseRegistryExpectations,
  resolveReleasePolicy,
} from './lib/npm-release-policy.mjs';
import { normalizeNpmPackResult } from './lib/npm-pack-result.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = path.join(repoRoot, 'scripts/npm-release.mjs');
const expectedPackage = '@zkp2p/contracts-v2';
const provenanceFixturePath = path.join(
  repoRoot,
  'scripts/fixtures/npm-audit-contracts-v2-0.4.0-rc.5.json',
);
const provenanceFixtureBytes = fs.readFileSync(provenanceFixturePath);
const provenanceAuditFixture = JSON.parse(provenanceFixtureBytes);
const provenanceArguments = {
  packageName: expectedPackage,
  release: '0.4.0-rc.5',
  integrity: 'sha512-Abwj6fucYlElyEVwOSSTUQT2BDLEdV0NXTZ6vj8GlRU9idnyKnnEuWn+h37VMyELnk8Jp9Q9fVMfM06KLwtnfw==',
  githubSha: '6f3199fc4c6154c9d2767e061a173870c758296d',
  runId: '30861109551',
  runAttempt: '1',
  environment: 'npm-publish-rc',
};
const validPackResult = {
  name: expectedPackage,
  version: '0.4.0',
  filename: 'zkp2p-contracts-v2-0.4.0.tgz',
  integrity: 'sha512-test',
  shasum: '0123456789abcdef',
};

function parseGitHubOutput(output) {
  return Object.fromEntries(
    fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

function releaseEnvironment(overrides = {}) {
  return {
    ...process.env,
    RELEASE_LINE: '0.4.0',
    LATEST_BASELINE: '0.3.0',
    RC_BASELINE: '0.4.0-rc.5',
    RECOVERY_MODE: 'false',
    ...overrides,
  };
}

function assertCliFails(args, env, pattern) {
  const result = spawnSync(process.execPath, [releaseScript, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function clone(value) {
  return structuredClone(value);
}

function provenanceFixture() {
  return clone(provenanceAuditFixture);
}

function provenanceEntry(report) {
  return report.verified.find(
    (entry) => entry.name === expectedPackage && entry.version === '0.4.0-rc.5',
  );
}

function slsaBundle(report) {
  return provenanceEntry(report).attestationBundles.find(
    (entry) => entry.predicateType === 'https://slsa.dev/provenance/v1',
  );
}

function mutatePayload(report, mutation) {
  const envelope = slsaBundle(report).bundle.dsseEnvelope;
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  mutation(payload);
  envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  return report;
}

function mutateCertificate(report, before, after) {
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  const certificate = slsaBundle(report).bundle.verificationMaterial.certificate;
  const raw = Buffer.from(certificate.rawBytes, 'base64');
  const position = raw.indexOf(before);
  assert.notEqual(position, -1, `certificate contains ${before}`);
  raw.write(after, position, 'utf8');
  certificate.rawBytes = raw.toString('base64');
  return report;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createReleaseGitFixture({ tagKind = 'annotated', recovery = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-git-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Release Test']);
  git(cwd, ['config', 'user.email', 'release@example.com']);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'release\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-m', 'release']);
  const tagArgs = tagKind === 'annotated'
    ? ['tag', '-a', 'contracts-v2-v0.4.0', '-m', 'release']
    : ['tag', 'contracts-v2-v0.4.0'];
  git(cwd, tagArgs);
  const tagSha = git(cwd, ['rev-parse', 'HEAD']);
  if (recovery) {
    fs.mkdirSync(path.join(cwd, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'scripts/lib/npm-release-policy.mjs'), 'recovery\n');
    git(cwd, ['add', 'scripts/lib/npm-release-policy.mjs']);
    git(cwd, ['commit', '-m', 'recovery']);
  }
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  git(cwd, ['update-ref', 'refs/remotes/zkp2p-canonical/main', sha]);
  return { cwd, sha, tagSha };
}

function canonicalArguments(fixture, overrides = {}) {
  return {
    cwd: fixture.cwd,
    githubRepository: 'zkp2p/zkp2p-contracts',
    githubEventName: 'workflow_dispatch',
    githubRef: 'refs/heads/main',
    githubSha: fixture.sha,
    releaseTag: 'contracts-v2-v0.4.0',
    recovery: false,
    ...overrides,
  };
}

function originalRunFixture(overrides = {}) {
  return {
    id: 123456789,
    run_attempt: 1,
    event: 'workflow_dispatch',
    head_sha: '0123456789abcdef0123456789abcdef01234567',
    path: '.github/workflows/publish-contracts-v2.yml',
    repository: { full_name: 'zkp2p/zkp2p-contracts' },
    conclusion: 'failure',
    ...overrides,
  };
}

function originalJobsFixture(overrides = {}) {
  return {
    jobs: [
      {
        name: 'Publish with npm OIDC',
        conclusion: 'success',
        started_at: '2026-08-06T10:00:00Z',
        completed_at: '2026-08-06T10:02:00Z',
      },
      {
        name: 'Verify published package',
        conclusion: 'failure',
        started_at: '2026-08-06T10:02:01Z',
        completed_at: '2026-08-06T10:03:00Z',
      },
      { name: 'Verify published release recovery', conclusion: 'skipped' },
    ],
    ...overrides,
  };
}

test('resolves an RC from the committed release-line prerelease', () => {
  assert.deepEqual(
    resolveReleasePolicy({
      release: '0.4.0-rc.6',
      packageVersion: '0.4.0-rc.6',
      releaseLine: '0.4.0',
    }),
    { channel: 'rc', distTag: 'rc', environment: 'npm-publish' },
  );
});

test('resolves the exact release line as stable', () => {
  assert.deepEqual(
    resolveReleasePolicy({
      release: '0.4.0',
      packageVersion: '0.4.0',
      releaseLine: '0.4.0',
    }),
    { channel: 'stable', distTag: 'latest', environment: 'npm-publish' },
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

test('resolve writes all release policy outputs', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-resolve-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packageJsonPath = path.join(temporaryDirectory, 'package.json');
  const outputPath = path.join(temporaryDirectory, 'github-output');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: expectedPackage, version: '0.4.0' }));

  execFileSync(process.execPath, [releaseScript, 'resolve', packageJsonPath, '0.4.0'], {
    cwd: repoRoot,
    env: releaseEnvironment({ GITHUB_OUTPUT: outputPath }),
  });

  assert.deepEqual(parseGitHubOutput(outputPath), {
    channel: 'stable',
    dist_tag: 'latest',
    environment: 'npm-publish',
    guard_latest: '0.3.0',
    guard_rc: '0.4.0-rc.5',
    verify_latest: '0.4.0',
    verify_rc: '0.4.0-rc.5',
  });
});

test('resolve uses postconditions as recovery guards', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-recover-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packageJsonPath = path.join(temporaryDirectory, 'package.json');
  const outputPath = path.join(temporaryDirectory, 'github-output');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: expectedPackage, version: '0.4.0' }));

  execFileSync(process.execPath, [releaseScript, 'resolve', packageJsonPath, '0.4.0'], {
    cwd: repoRoot,
    env: releaseEnvironment({ RECOVERY_MODE: 'true', GITHUB_OUTPUT: outputPath }),
  });

  const output = parseGitHubOutput(outputPath);
  assert.equal(output.guard_latest, output.verify_latest);
  assert.equal(output.guard_rc, output.verify_rc);
});

test('resolve requires GITHUB_OUTPUT in GitHub Actions', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-actions-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packageJsonPath = path.join(temporaryDirectory, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: expectedPackage, version: '0.4.0' }));
  const env = releaseEnvironment({ GITHUB_ACTIONS: 'true' });
  delete env.GITHUB_OUTPUT;

  assertCliFails(
    ['resolve', packageJsonPath, '0.4.0'],
    env,
    /GITHUB_OUTPUT must be set in GitHub Actions/,
  );
});

for (const recoveryMode of ['', 'yes', '1']) {
  test(`resolve rejects RECOVERY_MODE=${JSON.stringify(recoveryMode)}`, (context) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-mode-'));
    context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const packageJsonPath = path.join(temporaryDirectory, 'package.json');
    const outputPath = path.join(temporaryDirectory, 'github-output');
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: expectedPackage, version: '0.4.0' }));

    assertCliFails(
      ['resolve', packageJsonPath, '0.4.0'],
      releaseEnvironment({ RECOVERY_MODE: recoveryMode, GITHUB_OUTPUT: outputPath }),
      /RECOVERY_MODE must be exactly true or false/,
    );
  });
}

test('guard rejects a dist-tag that differs from the resolved policy', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-tag-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packageJsonPath = path.join(temporaryDirectory, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: expectedPackage, version: '0.4.0' }));

  assertCliFails(
    ['guard', packageJsonPath, '0.4.0', 'rc'],
    releaseEnvironment({ GITHUB_ACTIONS: 'false' }),
    /dist-tag rc does not match resolved dist-tag latest/,
  );
});

test('guard rejects an environment that differs from the resolved policy', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-environment-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packageJsonPath = path.join(temporaryDirectory, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ name: expectedPackage, version: '0.4.0' }));

  assertCliFails(
    ['guard', packageJsonPath, '0.4.0', 'latest'],
    releaseEnvironment({
      GITHUB_ACTIONS: 'false',
      RELEASE_ENVIRONMENT: 'npm-publish-rc',
    }),
    /environment npm-publish-rc does not match resolved environment npm-publish/,
  );
});

for (const [description, packJson] of [
  ['npm 11 array result', [validPackResult]],
  ['npm 12 keyed result', { [expectedPackage]: validPackResult }],
]) {
  test(`normalizes ${description}`, () => {
    assert.deepEqual(normalizeNpmPackResult(packJson, expectedPackage), validPackResult);
  });
}

for (const [description, packJson] of [
  ['empty results', []],
  ['duplicate results', [validPackResult, validPackResult]],
  ['duplicate keyed results', {
    [expectedPackage]: validPackResult,
    '@example/other': { ...validPackResult, name: '@example/other' },
  }],
  ['wrong package', [{ ...validPackResult, name: '@example/wrong' }]],
  ['missing version', [{ ...validPackResult, version: '' }]],
  ['missing filename', [{ ...validPackResult, filename: '' }]],
  ['missing integrity', [{ ...validPackResult, integrity: '' }]],
  ['missing shasum', [{ ...validPackResult, shasum: '' }]],
  ['unknown shape', { result: validPackResult }],
]) {
  test(`rejects ${description} from npm pack`, () => {
    assert.throws(() => normalizeNpmPackResult(packJson, expectedPackage), /npm pack result/);
  });
}

test('pack-path resolves the validated tarball inside the supplied directory', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-pack-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packDirectory = path.join(temporaryDirectory, 'pack');
  const packJsonPath = path.join(temporaryDirectory, 'pack.json');
  fs.mkdirSync(packDirectory);
  fs.writeFileSync(packJsonPath, JSON.stringify([validPackResult]));

  const result = execFileSync(
    process.execPath,
    [releaseScript, 'pack-path', packJsonPath, packDirectory],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();

  assert.equal(result, path.join(packDirectory, validPackResult.filename));
  assert.equal(path.dirname(result), packDirectory);
});

test('pack-path rejects a tarball outside the supplied directory', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-pack-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packDirectory = path.join(temporaryDirectory, 'pack');
  const packJsonPath = path.join(temporaryDirectory, 'pack.json');
  fs.mkdirSync(packDirectory);
  fs.writeFileSync(packJsonPath, JSON.stringify([{
    ...validPackResult,
    filename: '../outside.tgz',
  }]));

  assertCliFails(
    ['pack-path', packJsonPath, packDirectory],
    process.env,
    /pack path must stay inside the supplied directory/,
  );
});

test('accepts only an annotated release tag at exact canonical main', (context) => {
  const fixture = createReleaseGitFixture({ tagKind: 'annotated' });
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertCanonicalReleaseSource(canonicalArguments(fixture)));
});

test('rejects a lightweight release tag', (context) => {
  const fixture = createReleaseGitFixture({ tagKind: 'lightweight' });
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  assert.throws(
    () => assertCanonicalReleaseSource(canonicalArguments(fixture)),
    /must be an annotated tag object/,
  );
});

for (const [description, overrides, pattern] of [
  ['wrong repository', { githubRepository: 'fork/zkp2p-contracts' }, /repository must be zkp2p\/zkp2p-contracts/],
  ['non-dispatch event', { githubEventName: 'push' }, /event must be workflow_dispatch/],
  ['non-main ref', { githubRef: 'refs/heads/release' }, /ref must be refs\/heads\/main/],
  ['HEAD drift', { githubSha: '1111111111111111111111111111111111111111' }, /checked-out HEAD/],
]) {
  test(`rejects canonical source with ${description}`, (context) => {
    const fixture = createReleaseGitFixture();
    context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
    assert.throws(
      () => assertCanonicalReleaseSource(canonicalArguments(fixture, overrides)),
      pattern,
    );
  });
}

test('rejects canonical-main drift', (context) => {
  const fixture = createReleaseGitFixture();
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  git(fixture.cwd, ['update-ref', 'refs/remotes/zkp2p-canonical/main', 'contracts-v2-v0.4.0']);
  assert.throws(
    () => assertCanonicalReleaseSource(canonicalArguments(fixture)),
    /canonical main/,
  );
});

test('rejects release-tag drift for normal publication', (context) => {
  const fixture = createReleaseGitFixture({ recovery: true });
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  assert.throws(
    () => assertCanonicalReleaseSource(canonicalArguments(fixture)),
    /release tag.*not workflow SHA/,
  );
});

test('accepts recovery from an ancestor tag with only allowlisted changes', (context) => {
  const fixture = createReleaseGitFixture({ recovery: true });
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertCanonicalReleaseSource(canonicalArguments(fixture, {
    recovery: true,
  })));
});

test('rejects recovery when the release tag is not an ancestor', (context) => {
  const fixture = createReleaseGitFixture();
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  git(fixture.cwd, ['checkout', '--orphan', 'unrelated']);
  fs.writeFileSync(path.join(fixture.cwd, 'unrelated.txt'), 'unrelated\n');
  git(fixture.cwd, ['add', 'unrelated.txt']);
  git(fixture.cwd, ['commit', '-m', 'unrelated']);
  const sha = git(fixture.cwd, ['rev-parse', 'HEAD']);
  git(fixture.cwd, ['update-ref', 'refs/remotes/zkp2p-canonical/main', sha]);
  assert.throws(
    () => assertCanonicalReleaseSource(canonicalArguments({ ...fixture, sha }, { recovery: true })),
    /tag.*ancestor of canonical main/,
  );
});

test('rejects recovery changes outside the exact allowlist', (context) => {
  const fixture = createReleaseGitFixture({ recovery: true });
  context.after(() => fs.rmSync(fixture.cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.cwd, 'package.json'), '{}\n');
  git(fixture.cwd, ['add', 'package.json']);
  git(fixture.cwd, ['commit', '-m', 'package drift']);
  const sha = git(fixture.cwd, ['rev-parse', 'HEAD']);
  git(fixture.cwd, ['update-ref', 'refs/remotes/zkp2p-canonical/main', sha]);
  assert.throws(
    () => assertCanonicalReleaseSource(canonicalArguments({ ...fixture, sha }, { recovery: true })),
    /outside recovery code: package\.json/,
  );
});

test('pins the public RC5 provenance fixture and its protected identity', () => {
  assert.equal(provenanceFixtureBytes.length, 68557);
  assert.equal(
    createHash('sha256').update(provenanceFixtureBytes).digest('hex'),
    '9ea8e099181b71ba99d6880910b87b754dd9c25e2bf7656815e8378fe80f5bcf',
  );
  const entry = provenanceEntry(provenanceAuditFixture);
  assert.equal(entry.name, expectedPackage);
  assert.equal(entry.version, '0.4.0-rc.5');
  assert.doesNotThrow(() => assertVerifiedProvenance({
    auditReport: provenanceFixture(),
    ...provenanceArguments,
  }));
});

test('provenance CLI runs npm cryptographic verification in the clean consumer directory', (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-release-provenance-'));
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const binDirectory = path.join(temporaryDirectory, 'bin');
  const consumerDirectory = path.join(temporaryDirectory, 'consumer');
  const packageJsonPath = path.join(temporaryDirectory, 'package.json');
  const packJsonPath = path.join(temporaryDirectory, 'pack.json');
  const invocationPath = path.join(temporaryDirectory, 'invocation.json');
  fs.mkdirSync(binDirectory);
  fs.mkdirSync(consumerDirectory);
  fs.writeFileSync(packageJsonPath, JSON.stringify({
    name: expectedPackage,
    version: '0.4.0-rc.5',
  }));
  fs.writeFileSync(packJsonPath, JSON.stringify([{
    ...validPackResult,
    version: '0.4.0-rc.5',
    integrity: provenanceArguments.integrity,
  }]));
  const npmPath = path.join(binDirectory, 'npm');
  fs.writeFileSync(npmPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.INVOCATION_PATH, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(fs.readFileSync(process.env.AUDIT_FIXTURE));
`);
  fs.chmodSync(npmPath, 0o755);

  execFileSync(process.execPath, [
    releaseScript,
    'provenance',
    packageJsonPath,
    '0.4.0-rc.5',
    packJsonPath,
    consumerDirectory,
  ], {
    cwd: repoRoot,
    env: releaseEnvironment({
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      INVOCATION_PATH: invocationPath,
      AUDIT_FIXTURE: provenanceFixturePath,
      GITHUB_SHA: provenanceArguments.githubSha,
      GITHUB_RUN_ID: provenanceArguments.runId,
      GITHUB_RUN_ATTEMPT: provenanceArguments.runAttempt,
      RELEASE_ENVIRONMENT: provenanceArguments.environment,
      RECOVERY_MODE: 'false',
    }),
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(invocationPath, 'utf8')), {
    args: ['audit', 'signatures', '--json', '--include-attestations'],
    cwd: fs.realpathSync(consumerDirectory),
  });
});

const provenanceMutations = [
  ['PURL name', (report) => mutatePayload(report, (payload) => { payload.subject[0].name = 'pkg:npm/example@0.4.0-rc.5'; }), /subject PURL/],
  ['PURL version', (report) => mutatePayload(report, (payload) => { payload.subject[0].name = 'pkg:npm/%40zkp2p/contracts-v2@0.4.0-rc.6'; }), /subject PURL/],
  ['SHA-512 subject digest', (report) => mutatePayload(report, (payload) => { payload.subject[0].digest.sha512 = '00'.repeat(64); }), /subject SHA-512/],
  ['repository', (report) => mutatePayload(report, (payload) => { payload.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/fork/contracts'; }), /workflow repository/],
  ['workflow path', (report) => mutatePayload(report, (payload) => { payload.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; }), /workflow path/],
  ['ref', (report) => mutatePayload(report, (payload) => { payload.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/release'; }), /workflow ref/],
  ['Git commit', (report) => mutatePayload(report, (payload) => { payload.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = '0'.repeat(40); }), /Git commit/],
  ['event', (report) => mutatePayload(report, (payload) => { payload.predicate.buildDefinition.internalParameters.github.event_name = 'push'; }), /event/],
  ['invocation run ID', (report) => mutatePayload(report, (payload) => { payload.predicate.runDetails.metadata.invocationId = 'https://github.com/zkp2p/zkp2p-contracts/actions/runs/1/attempts/1'; }), /invocation ID/],
  ['invocation attempt', (report) => mutatePayload(report, (payload) => { payload.predicate.runDetails.metadata.invocationId = 'https://github.com/zkp2p/zkp2p-contracts/actions/runs/30861109551/attempts/2'; }), /invocation ID/],
  ['certificate SAN', (report) => mutateCertificate(report, 'zkp2p/zkp2p-contracts', 'xxxxx/xxxxx-contracts'), /certificate SAN/],
  ['certificate OIDC issuer', (report) => mutateCertificate(report, 'token.actions.githubusercontent.com', 'x'.repeat(35)), /OIDC issuer/],
  ['certificate environment', (report) => mutateCertificate(report, 'npm-publish-rc', 'npm-publish-xx'), /certificate environment/],
];

for (const [claim, mutation, pattern] of provenanceMutations) {
  test(`rejects a mutated provenance ${claim}`, () => {
    assert.throws(
      () => assertVerifiedProvenance({
        auditReport: mutation(provenanceFixture()),
        ...provenanceArguments,
      }),
      pattern,
    );
  });
}

for (const [description, mutation, pattern] of [
  ['missing package entry', (report) => { report.verified = report.verified.filter((entry) => entry.name !== expectedPackage); }, /exactly one verified package entry/],
  ['duplicate package entry', (report) => { report.verified.push(clone(provenanceEntry(report))); }, /exactly one verified package entry/],
  ['missing SLSA bundle', (report) => { provenanceEntry(report).attestationBundles = []; }, /exactly one SLSA v1 bundle/],
  ['duplicate SLSA bundle', (report) => { provenanceEntry(report).attestationBundles.push(clone(slsaBundle(report))); }, /exactly one SLSA v1 bundle/],
  ['duplicate subject', (report) => mutatePayload(report, (payload) => { payload.subject.push(clone(payload.subject[0])); }), /exactly one provenance subject/],
]) {
  test(`rejects provenance with ${description}`, () => {
    const report = provenanceFixture();
    mutation(report);
    assert.throws(
      () => assertVerifiedProvenance({ auditReport: report, ...provenanceArguments }),
      pattern,
    );
  });
}

test('reads definite-length unique DER extensions', () => {
  const extensions = readDerExtensions(Buffer.from('300c300a06032a03040c03656e76', 'hex'));
  assert.equal(extensions.get('1.2.3.4').toString(), 'env');
});

for (const [description, hex, pattern] of [
  ['indefinite length', '30803000', /indefinite DER length/],
  ['out-of-bounds length', '30053000', /DER length exceeds input/],
  ['duplicate OID', '3018300a06032a03040c03656e76300a06032a03040c03656e76', /duplicate DER OID/],
  ['invalid UTF-8 OID value', '300b300906032a03040c02c328', /invalid UTF-8/],
  ['non-UTF8String value', '300a300806032a0304040178', /UTF8String/],
  ['trailing bytes', '300c300a06032a03040c03656e7600', /trailing DER bytes/],
]) {
  test(`rejects ${description} in DER extension data`, () => {
    assert.throws(() => readDerExtensions(Buffer.from(hex, 'hex')), pattern);
  });
}

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

test('accepts a successful post-publish verification job', () => {
  const jobs = originalJobsFixture();
  jobs.jobs[1].conclusion = 'success';
  assert.doesNotThrow(() => assertOriginalPublishRun({
    run: originalRunFixture({ conclusion: 'success' }), jobs,
    expectedRepository: 'zkp2p/zkp2p-contracts',
    expectedWorkflowPath: '.github/workflows/publish-contracts-v2.yml',
    expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
    expectedRunId: '123456789', expectedRunAttempt: '1',
  }));
});

for (const [description, overrides, pattern] of [
  ['malformed run ID', { expectedRunId: '12x' }, /run ID must be numeric/],
  ['malformed attempt', { expectedRunAttempt: '' }, /run attempt must be numeric/],
  ['wrong run ID', { expectedRunId: '123456788' }, /run ID/],
  ['wrong attempt', { expectedRunAttempt: '2' }, /run attempt/],
  ['wrong repository', { run: originalRunFixture({ repository: { full_name: 'fork/repo' } }) }, /repository/],
  ['wrong workflow path', { run: originalRunFixture({ path: '.github/workflows/other.yml' }) }, /workflow path/],
  ['wrong event', { run: originalRunFixture({ event: 'push' }) }, /workflow_dispatch/],
  ['wrong head SHA', { run: originalRunFixture({ head_sha: '0'.repeat(40) }) }, /head SHA/],
]) {
  test(`rejects original publish run with ${description}`, () => {
    assert.throws(() => assertOriginalPublishRun({
      run: originalRunFixture(), jobs: originalJobsFixture(),
      expectedRepository: 'zkp2p/zkp2p-contracts',
      expectedWorkflowPath: '.github/workflows/publish-contracts-v2.yml',
      expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      expectedRunId: '123456789', expectedRunAttempt: '1',
      ...overrides,
    }), pattern);
  });
}

for (const [description, mutateJobs, pattern] of [
  ['missing publish job', (jobs) => { jobs.jobs = jobs.jobs.filter((job) => job.name !== 'Publish with npm OIDC'); }, /exactly one Publish with npm OIDC job/],
  ['duplicate publish job', (jobs) => { jobs.jobs.push(clone(jobs.jobs[0])); }, /exactly one Publish with npm OIDC job/],
  ['failed publish job', (jobs) => { jobs.jobs[0].conclusion = 'failure'; }, /publish job must succeed/],
  ['skipped publish job', (jobs) => { jobs.jobs[0].conclusion = 'skipped'; }, /publish job must succeed/],
  ['verification before publish', (jobs) => { jobs.jobs[1].started_at = '2026-08-06T10:01:00Z'; }, /verification job must start after publication/],
  ['missing publish completion timestamp', (jobs) => { delete jobs.jobs[0].completed_at; }, /timestamps must be valid/],
  ['invalid verification start timestamp', (jobs) => { jobs.jobs[1].started_at = 'invalid'; }, /timestamps must be valid/],
  ['non-skipped recovery job', (jobs) => { jobs.jobs[2].conclusion = 'success'; }, /recovery job must be skipped/],
]) {
  test(`rejects original jobs with ${description}`, () => {
    const jobs = originalJobsFixture();
    mutateJobs(jobs);
    assert.throws(() => assertOriginalPublishRun({
      run: originalRunFixture(), jobs,
      expectedRepository: 'zkp2p/zkp2p-contracts',
      expectedWorkflowPath: '.github/workflows/publish-contracts-v2.yml',
      expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
      expectedRunId: '123456789', expectedRunAttempt: '1',
    }), pattern);
  });
}
