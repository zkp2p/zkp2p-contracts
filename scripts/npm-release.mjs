#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

import { normalizeNpmPackResult } from './lib/npm-pack-result.mjs';
import {
  assertExpectedDistTags,
  releaseRegistryExpectations,
  resolveReleasePolicy,
} from './lib/npm-release-policy.mjs';

const [, , command, packageJsonArg, release, tag, extraArg] = process.argv;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releasePackage = '@zkp2p/contracts-v2';

function fail(message) {
  console.error(`Release validation failed: ${message}`);
  process.exit(1);
}

if (command === 'pack-path') {
  if (!packageJsonArg || !release || tag) {
    fail('usage: npm-release.mjs pack-path <pack.json> <pack-dir>');
  }
  const packJsonPath = path.resolve(packageJsonArg);
  const packDirectory = path.resolve(release);
  let packResult;
  try {
    packResult = normalizeNpmPackResult(
      JSON.parse(fs.readFileSync(packJsonPath, 'utf8')),
      releasePackage,
    );
  } catch (error) {
    fail(error.message);
  }
  const tarballPath = path.resolve(packDirectory, packResult.filename);
  const relativeTarballPath = path.relative(packDirectory, tarballPath);
  if (
    !relativeTarballPath ||
    relativeTarballPath === '..' ||
    relativeTarballPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarballPath)
  ) {
    fail('pack path must stay inside the supplied directory');
  }
  console.log(tarballPath);
  process.exit(0);
}

if (!['resolve', 'guard', 'recover', 'verify'].includes(command) || !packageJsonArg || !release) {
  fail('usage: npm-release.mjs resolve <package.json> <version> OR npm-release.mjs <guard|recover|verify> <package.json> <version> <dist-tag> [pack.json]');
}
if (command === 'resolve' && tag) {
  fail('resolve takes only <package.json> and <version>');
}
if (command !== 'resolve' && !tag) {
  fail('guard, recover, and verify require the resolved dist-tag');
}

const packageJsonPath = path.resolve(packageJsonArg);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

if (!semverPattern.test(release)) fail(`release input is not valid SemVer: ${release}`);

const releaseLine = process.env.RELEASE_LINE;
if (!releaseLine) fail('RELEASE_LINE must be set by the repository-controlled release workflow');
let policy;
try {
  policy = resolveReleasePolicy({
    release,
    packageVersion: packageJson.version,
    releaseLine,
  });
} catch (error) {
  fail(error.message);
}

if (command === 'resolve') {
  const recoveryMode = process.env.RECOVERY_MODE;
  if (recoveryMode !== 'true' && recoveryMode !== 'false') {
    fail('RECOVERY_MODE must be exactly true or false');
  }
  const baselines = {
    latest: process.env.LATEST_BASELINE,
    rc: process.env.RC_BASELINE,
  };
  try {
    assertExpectedDistTags(baselines, baselines);
  } catch (error) {
    fail(error.message);
  }
  const expectations = releaseRegistryExpectations({
    channel: policy.channel,
    release,
    recovery: recoveryMode === 'true',
    baselines,
  });
  const outputs = {
    channel: policy.channel,
    dist_tag: policy.distTag,
    environment: policy.environment,
    guard_latest: expectations.guard.latest,
    guard_rc: expectations.guard.rc,
    verify_latest: expectations.verify.latest,
    verify_rc: expectations.verify.rc,
  };
  const outputText = `${Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
  if (process.env.GITHUB_ACTIONS === 'true' && !process.env.GITHUB_OUTPUT) {
    fail('GITHUB_OUTPUT must be set in GitHub Actions');
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(path.resolve(process.env.GITHUB_OUTPUT), outputText);
  }
  process.stdout.write(outputText);
  process.exit(0);
}

if (tag !== policy.distTag) {
  fail(`dist-tag ${tag} does not match resolved dist-tag ${policy.distTag}`);
}
if (process.env.DIST_TAG !== undefined && process.env.DIST_TAG !== policy.distTag) {
  fail(`DIST_TAG ${process.env.DIST_TAG} does not match resolved dist-tag ${policy.distTag}`);
}
if (
  process.env.RELEASE_ENVIRONMENT !== undefined &&
  process.env.RELEASE_ENVIRONMENT !== policy.environment
) {
  fail(
    `environment ${process.env.RELEASE_ENVIRONMENT} does not match resolved environment ${policy.environment}`,
  );
}

const registryBase = (packageJson.publishConfig?.registry || 'https://registry.npmjs.org').replace(/\/$/, '');
const encodedName = encodeURIComponent(packageJson.name);
const versionUrl = `${registryBase}/${encodedName}/${encodeURIComponent(release)}`;

async function readJson(url, allowedStatuses = [200]) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`registry returned HTTP ${response.status} for ${url}`);
  }
  return response.status === 404 ? null : response.json();
}

if (command === 'guard' || command === 'recover') {
  if (process.env.GITHUB_ACTIONS === 'true') {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
      fail(`publishing requires workflow_dispatch, received ${process.env.GITHUB_EVENT_NAME}`);
    }
    if (process.env.GITHUB_REF !== 'refs/heads/main') {
      fail(`publishing is restricted to refs/heads/main, received ${process.env.GITHUB_REF}`);
    }
    const expectedTag = process.env.RELEASE_TAG;
    if (!expectedTag) fail('RELEASE_TAG must be set by the repository-controlled RC workflow');
    const taggedCommit = execFileSync('git', ['rev-parse', `${expectedTag}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    const checkedOutCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const currentMain = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], {
      encoding: 'utf8',
    }).trim();
    if (checkedOutCommit !== process.env.GITHUB_SHA) {
      fail(`checked-out commit ${checkedOutCommit} does not match workflow SHA ${process.env.GITHUB_SHA}`);
    }
    if (currentMain !== process.env.GITHUB_SHA) {
      fail(`canonical main is ${currentMain}, not workflow SHA ${process.env.GITHUB_SHA}`);
    }
    if (taggedCommit !== process.env.GITHUB_SHA) {
      if (command !== 'recover') {
        fail(`release tag ${expectedTag} points to ${taggedCommit}, not workflow SHA ${process.env.GITHUB_SHA}`);
      }
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', taggedCommit, checkedOutCommit]);
      } catch {
        fail(`recovery requires release tag ${expectedTag} to be an ancestor of canonical main`);
      }
      const changedFiles = execFileSync(
        'git',
        ['diff', '--name-only', `${taggedCommit}..${checkedOutCommit}`],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      const allowedRecoveryChanges = new Set([
        '.agents/skills/zkp2p-contracts-publish/SKILL.md',
        '.github/workflows/publish-contracts-v2.yml',
        'NPM_RELEASE.md',
        'scripts/npm-release.mjs',
        'scripts/verify-github-environment.spec.mjs',
      ]);
      const unexpectedChanges = changedFiles.filter((file) => !allowedRecoveryChanges.has(file));
      if (unexpectedChanges.length > 0) {
        fail(`recovery main differs from the release tag outside recovery code: ${unexpectedChanges.join(', ')}`);
      }
    }
  }
  const existing = await readJson(versionUrl, [200, 404]);
  if (command === 'guard' && existing) fail(`${packageJson.name}@${release} is already published`);
  if (command === 'recover' && !existing) fail(`${packageJson.name}@${release} is not published`);
  console.log(`${command === 'guard' ? 'Release' : 'Recovery'} guard passed for ${packageJson.name}@${release} with dist-tag ${tag}.`);
  process.exit(0);
}

if (!extraArg) fail('verify requires the pre-publish npm pack JSON path');
let packResult;
try {
  packResult = normalizeNpmPackResult(
    JSON.parse(fs.readFileSync(path.resolve(extraArg), 'utf8')),
    packageJson.name,
  );
} catch (error) {
  fail(error.message);
}

const packageUrl = `${registryBase}/${encodedName}`;
let lastReason = 'registry metadata was not available';
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const metadata = await readJson(packageUrl);
    const published = metadata.versions?.[release];
    if (!published) {
      lastReason = `version ${release} is not visible`;
    } else if (metadata['dist-tags']?.[tag] !== release) {
      lastReason = `dist-tag ${tag} points to ${metadata['dist-tags']?.[tag] || '<missing>'}`;
    } else if (
      process.env.EXPECTED_LATEST &&
      metadata['dist-tags']?.latest !== process.env.EXPECTED_LATEST
    ) {
      lastReason = `latest moved from ${process.env.EXPECTED_LATEST} to ${metadata['dist-tags']?.latest || '<missing>'}`;
    } else if (published.dist?.integrity !== packResult.integrity) {
      lastReason = 'registry integrity does not match the validated tarball';
    } else if (
      process.env.REQUIRE_PROVENANCE === 'true' &&
      !published.dist?.attestations?.url
    ) {
      lastReason = 'npm provenance attestation is missing';
    } else {
      console.log(`Registry verification passed for ${packageJson.name}@${release} (${tag}).`);
      process.exit(0);
    }
  } catch (error) {
    lastReason = error.message;
  }
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5_000));
}

fail(`post-publish verification timed out: ${lastReason}`);
