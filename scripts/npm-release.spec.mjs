import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertExpectedDistTags,
  postPublishDistTags,
  releaseRegistryExpectations,
  resolveReleasePolicy,
} from './lib/npm-release-policy.mjs';
import { normalizeNpmPackResult } from './lib/npm-pack-result.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = path.join(repoRoot, 'scripts/npm-release.mjs');
const expectedPackage = '@zkp2p/contracts-v2';
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
    environment: 'npm-publish-stable',
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
    /environment npm-publish-rc does not match resolved environment npm-publish-stable/,
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
