import assert from 'node:assert/strict';
import test from 'node:test';

import { assertReleaseEnvironment } from './lib/release-environment-policy.mjs';

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
    assertReleaseEnvironment(validEnvironment(), 'npm-publish-rc', mainOnlyPolicy()),
  );
});

test('rejects required reviewers', () => {
  const environment = validEnvironment();
  environment.protection_rules = [{ type: 'required_reviewers' }];
  assert.throws(
    () => assertReleaseEnvironment(environment, 'npm-publish-rc', mainOnlyPolicy()),
    /must not gate autonomous RC publishing/,
  );
});

test('rejects protected-branch mode', () => {
  const environment = validEnvironment();
  environment.deployment_branch_policy = {
    protected_branches: true,
    custom_branch_policies: false,
  };
  assert.throws(
    () => assertReleaseEnvironment(environment, 'npm-publish-rc', mainOnlyPolicy()),
    /custom deployment branch policies/,
  );
});

test('rejects any branch policy other than exactly main', () => {
  assert.throws(
    () =>
      assertReleaseEnvironment(validEnvironment(), 'npm-publish-rc', [
        { name: 'releases/*', type: 'branch' },
      ]),
    /exactly the main branch/,
  );
});
