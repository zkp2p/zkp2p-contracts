#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

import { normalizeNpmPackResult } from './lib/npm-pack-result.mjs';
import {
  assertCanonicalReleaseSource,
  assertOriginalPublishRun,
  assertSuppliedDistTags,
  assertVerifiedProvenance,
  fetchAllRunJobs,
  releaseRegistryExpectations,
  resolveReleasePolicy,
} from './lib/npm-release-policy.mjs';

const [, , command, packageJsonArg, release, tag, extraArg] = process.argv;
const coreSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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

if (command === 'provenance') {
  if (!packageJsonArg || !release || !tag || !extraArg || process.argv.length !== 7) {
    fail('usage: npm-release.mjs provenance <package.json> <version> <pack.json> <consumer-directory>');
  }
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(packageJsonArg), 'utf8'));
  if (packageJson.name !== releasePackage || packageJson.version !== release) {
    fail(`provenance package must be ${releasePackage}@${release}`);
  }
  const provenanceReleaseLine = process.env.RELEASE_LINE;
  if (!provenanceReleaseLine) {
    fail('RELEASE_LINE must be set by the repository-controlled release workflow');
  }
  let provenancePolicy;
  try {
    provenancePolicy = resolveReleasePolicy({
      release,
      packageVersion: packageJson.version,
      releaseLine: provenanceReleaseLine,
    });
  } catch (error) {
    fail(error.message);
  }
  if (
    process.env.RELEASE_ENVIRONMENT !== undefined &&
    process.env.RELEASE_ENVIRONMENT !== provenancePolicy.environment
  ) {
    fail(
      `environment ${process.env.RELEASE_ENVIRONMENT} does not match resolved environment ${provenancePolicy.environment}`,
    );
  }
  let packResult;
  try {
    packResult = normalizeNpmPackResult(
      JSON.parse(fs.readFileSync(path.resolve(tag), 'utf8')),
      releasePackage,
    );
  } catch (error) {
    fail(error.message);
  }
  if (packResult.version !== release) fail(`npm pack version ${packResult.version} does not match ${release}`);

  const recovery = process.env.RECOVERY_MODE === 'true';
  if (process.env.RECOVERY_MODE !== 'true' && process.env.RECOVERY_MODE !== 'false') {
    fail('RECOVERY_MODE must be exactly true or false');
  }
  let githubSha = process.env.GITHUB_SHA;
  let runId = process.env.GITHUB_RUN_ID;
  let runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (recovery) {
    const releaseTag = process.env.RELEASE_TAG;
    const originalRunId = process.env.RELEASE_RUN_ID;
    const githubToken = process.env.GITHUB_TOKEN;
    if (!releaseTag || !githubToken) fail('recovery provenance requires RELEASE_TAG and GITHUB_TOKEN');
    githubSha = execFileSync('git', ['rev-parse', `${releaseTag}^{commit}`], {
      encoding: 'utf8',
    }).trim();
    if (!/^[1-9]\d*$/.test(originalRunId || '')) fail('recovery provenance requires numeric RELEASE_RUN_ID');
    const apiBase = `https://api.github.com/repos/zkp2p/zkp2p-contracts/actions/runs/${originalRunId}`;
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${githubToken}`,
      'x-github-api-version': '2022-11-28',
    };
    let runResponse;
    let jobs;
    try {
      [runResponse, jobs] = await Promise.all([
        fetch(apiBase, { headers, signal: AbortSignal.timeout(30_000) }),
        fetchAllRunJobs(apiBase, headers),
      ]);
    } catch (error) {
      fail(error.message);
    }
    if (!runResponse.ok) fail(`GitHub Actions run API returned HTTP ${runResponse.status}`);
    const run = await runResponse.json();
    runId = originalRunId;
    try {
      runAttempt = assertOriginalPublishRun({
        run,
        jobs,
        expectedRepository: 'zkp2p/zkp2p-contracts',
        expectedWorkflowPath: '.github/workflows/publish-contracts-v2.yml',
        expectedHeadSha: githubSha,
        expectedRunId: runId,
      });
    } catch (error) {
      fail(error.message);
    }
  }
  for (const [value, label] of [
    [githubSha, 'GITHUB_SHA'],
    [runId, 'GITHUB_RUN_ID'],
    [runAttempt, 'GITHUB_RUN_ATTEMPT'],
  ]) {
    if (!value) fail(`${label} must be set for provenance verification`);
  }
  let auditReport;
  try {
    auditReport = JSON.parse(execFileSync(
      'npm',
      ['audit', 'signatures', '--json', '--include-attestations'],
      { cwd: path.resolve(extraArg), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    ));
    assertVerifiedProvenance({
      auditReport,
      packageName: packageJson.name,
      release,
      integrity: packResult.integrity,
      githubSha,
      runId,
      runAttempt,
      environment: provenancePolicy.environment,
    });
  } catch (error) {
    fail(error.message);
  }
  console.log(`Verified npm provenance for ${packageJson.name}@${release}.`);
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
  if (!baselines.latest) fail('expected latest baseline is missing');
  if (!coreSemverPattern.test(baselines.latest)) fail('LATEST_BASELINE must be core SemVer');
  if (!baselines.rc) fail('expected rc baseline is missing');
  if (!semverPattern.test(baselines.rc)) fail('RC_BASELINE must be valid SemVer');
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
  for (const [name, value] of Object.entries(outputs)) {
    if (/\r|\n/.test(value)) fail(`GitHub output ${name} must not contain CR or LF`);
  }
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
    const expectedTag = process.env.RELEASE_TAG;
    if (!expectedTag) fail('RELEASE_TAG must be set by the repository-controlled RC workflow');
    try {
      execFileSync('git', [
        'fetch', '--no-tags', 'https://github.com/zkp2p/zkp2p-contracts.git',
        '+main:refs/remotes/zkp2p-canonical/main',
      ]);
      execFileSync('git', [
        'fetch', '--no-tags', 'https://github.com/zkp2p/zkp2p-contracts.git',
        `+refs/tags/${expectedTag}:refs/tags/${expectedTag}`,
      ]);
      assertCanonicalReleaseSource({
        cwd: process.cwd(),
        githubRepository: process.env.GITHUB_REPOSITORY,
        githubEventName: process.env.GITHUB_EVENT_NAME,
        githubRef: process.env.GITHUB_REF,
        githubSha: process.env.GITHUB_SHA,
        releaseTag: expectedTag,
        recovery: command === 'recover',
      });
    } catch (error) {
      fail(error.message);
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
    } else {
      assertSuppliedDistTags(metadata['dist-tags'], {
        latest: process.env.EXPECTED_LATEST,
        rc: process.env.EXPECTED_RC,
      });
      if (published.dist?.integrity !== packResult.integrity) {
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
    }
  } catch (error) {
    lastReason = error.message;
  }
  if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5_000));
}

fail(`post-publish verification timed out: ${lastReason}`);
