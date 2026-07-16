#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [, , command, packageJsonArg, release, tag, extraArg] = process.argv;
const allowedTags = new Set(['dev', 'rc', 'latest']);
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`Release validation failed: ${message}`);
  process.exit(1);
}

if (!['guard', 'verify'].includes(command) || !packageJsonArg || !release || !tag) {
  fail('usage: npm-release.mjs <guard|verify> <package.json> <version> <dev|rc|latest> [pack.json]');
}

const packageJsonPath = path.resolve(packageJsonArg);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const match = release.match(semverPattern);

if (!match) fail(`release input is not valid SemVer: ${release}`);
if (!allowedTags.has(tag)) fail(`unsupported npm dist-tag: ${tag}`);
if (packageJson.version !== release) {
  fail(`release input ${release} does not match ${packageJson.name} package version ${packageJson.version}`);
}

const isPrerelease = Boolean(match[4]);
if (tag === 'latest' && isPrerelease) fail('latest requires a stable SemVer without a prerelease suffix');
if (tag !== 'latest' && !isPrerelease) fail(`${tag} requires a prerelease SemVer`);

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

if (command === 'guard') {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF !== 'refs/heads/main') {
    fail(`publishing is restricted to refs/heads/main, received ${process.env.GITHUB_REF}`);
  }
  const existing = await readJson(versionUrl, [200, 404]);
  if (existing) fail(`${packageJson.name}@${release} is already published`);
  console.log(`Release guard passed for ${packageJson.name}@${release} with dist-tag ${tag}.`);
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
    } else if (published.dist?.integrity !== packResult.integrity) {
      lastReason = 'registry integrity does not match the validated tarball';
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
