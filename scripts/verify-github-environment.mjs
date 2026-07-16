#!/usr/bin/env node

import process from 'node:process';

import { assertReleaseEnvironment } from './lib/release-environment-policy.mjs';

const environmentName = process.argv[2];
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiVersion = '2022-11-28';

function fail(message) {
  console.error(`GitHub environment validation failed: ${message}`);
  process.exit(1);
}

if (!environmentName || !repository) {
  fail('usage requires an environment name and GITHUB_REPOSITORY');
}

async function github(pathname) {
  const response = await fetch(`https://api.github.com/repos/${repository}${pathname}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-github-api-version': apiVersion,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    fail(`GitHub returned HTTP ${response.status} for ${pathname}`);
  }
  return response.json();
}

const environment = await github(`/environments/${encodeURIComponent(environmentName)}`);
try {
  assertReleaseEnvironment(environment, environmentName);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`GitHub environment ${environmentName} requires independent review, disables admin bypass, and restricts releases to protected main.`);
