export function assertReleaseEnvironment(environment, environmentName) {
  const reviewerRule = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (!reviewerRule || !Array.isArray(reviewerRule.reviewers) || reviewerRule.reviewers.length === 0) {
    throw new Error(`${environmentName} must have at least one required reviewer`);
  }
  if (reviewerRule.prevent_self_review !== true) {
    throw new Error(`${environmentName} must prevent self-review`);
  }
  if (environment.can_admins_bypass !== false) {
    throw new Error(`${environmentName} must disable administrator bypass`);
  }

  const policy = environment.deployment_branch_policy;
  if (policy?.protected_branches !== true || policy?.custom_branch_policies === true) {
    throw new Error(`${environmentName} must restrict deployments to protected branches`);
  }
}
