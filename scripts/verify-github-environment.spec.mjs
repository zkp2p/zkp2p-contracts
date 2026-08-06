import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertReleaseEnvironment } from './lib/release-environment-policy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validEnvironment() {
  return {
    protection_rules: [],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
}

function mainOnlyPolicy() {
  return [{ name: 'main', type: 'branch' }];
}

test('accepts an autonomous environment restricted to main', () => {
  assert.doesNotThrow(() =>
    assertReleaseEnvironment(validEnvironment(), 'npm-publish', mainOnlyPolicy()),
  );
});

test('rejects required reviewers', () => {
  const environment = validEnvironment();
  environment.protection_rules = [{ type: 'required_reviewers' }];
  assert.throws(
    () => assertReleaseEnvironment(environment, 'npm-publish', mainOnlyPolicy()),
    /must not gate autonomous publishing/,
  );
});

test('rejects protected-branch mode', () => {
  const environment = validEnvironment();
  environment.deployment_branch_policy = {
    protected_branches: true,
    custom_branch_policies: false,
  };
  assert.throws(
    () => assertReleaseEnvironment(environment, 'npm-publish', mainOnlyPolicy()),
    /custom deployment branch policies/,
  );
});

test('rejects any branch policy other than exactly main', () => {
  assert.throws(
    () =>
      assertReleaseEnvironment(validEnvironment(), 'npm-publish', [
        { name: 'releases/*', type: 'branch' },
      ]),
    /exactly the main branch/,
  );
});

test('rejects a tag policy named main', () => {
  assert.throws(
    () =>
      assertReleaseEnvironment(validEnvironment(), 'npm-publish', [
        { name: 'main', type: 'tag' },
      ]),
    /exactly the main branch/,
  );
});

test('recovery verifies the original publish artifact', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/publish-contracts-v2.yml'),
    'utf8',
  );

  assert.match(workflow, /^\s{6}release_run_id:\s*$/m);
  assert.match(workflow, /run-id:\s+\$\{\{ inputs\.release_run_id \}\}/);
  assert.match(workflow, /github-token:\s+\$\{\{ github\.token \}\}/);
});
