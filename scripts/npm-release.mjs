#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const [, , command, packageJsonArg, release, tag, extraArg] = process.argv;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`Release validation failed: ${message}`);
  process.exit(1);
}

if (!['guard', 'recover', 'verify'].includes(command) || !packageJsonArg || !release || !tag) {
  fail('usage: npm-release.mjs <guard|recover|verify> <package.json> <version> rc [pack.json]');
}

const packageJsonPath = path.resolve(packageJsonArg);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const match = release.match(semverPattern);

if (!match) fail(`release input is not valid SemVer: ${release}`);
if (tag !== 'rc') fail(`RC workflow requires the hard-coded rc dist-tag, received ${tag}`);
if (packageJson.version !== release) {
  fail(`release input ${release} does not match ${packageJson.name} package version ${packageJson.version}`);
}

const releaseLine = process.env.RELEASE_LINE;
if (!releaseLine) fail('RELEASE_LINE must be set by the repository-controlled RC workflow');
const escapedReleaseLine = releaseLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (!new RegExp(`^${escapedReleaseLine}-rc\\.(0|[1-9]\\d*)$`).test(release)) {
  fail(`release must match ${releaseLine}-rc.N exactly`);
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
const packResult = JSON.parse(fs.readFileSync(path.resolve(extraArg), 'utf8'))[0];
if (!packResult?.integrity) fail('pack JSON does not contain an integrity value');

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
