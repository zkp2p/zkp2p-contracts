import assert from 'node:assert/strict';
import test from 'node:test';

import { assertReleaseEnvironment } from './lib/release-environment-policy.mjs';

function validEnvironment() {
  return {
    can_admins_bypass: false,
    protection_rules: [
      {
        type: 'required_reviewers',
        reviewers: [{ type: 'User', reviewer: { login: 'release-maintainer' } }],
        prevent_self_review: true,
      },
    ],
    deployment_branch_policy: {
      protected_branches: true,
      custom_branch_policies: false,
    },
  };
}

test('accepts an independently reviewed environment with admin bypass disabled', () => {
  assert.doesNotThrow(() => assertReleaseEnvironment(validEnvironment(), 'npm-publish'));
});

test('rejects an environment with admin bypass enabled', () => {
  const environment = validEnvironment();
  environment.can_admins_bypass = true;

  assert.throws(
    () => assertReleaseEnvironment(environment, 'npm-publish'),
    /must disable administrator bypass/,
  );
});

test('fails closed when the admin bypass setting is absent', () => {
  const environment = validEnvironment();
  delete environment.can_admins_bypass;

  assert.throws(
    () => assertReleaseEnvironment(environment, 'npm-publish'),
    /must disable administrator bypass/,
  );
});
