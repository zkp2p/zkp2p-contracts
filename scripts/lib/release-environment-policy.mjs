export function assertReleaseEnvironment(environment, environmentName, branchPolicies) {
  const blockingRules = (environment.protection_rules || []).filter((rule) =>
    ['required_reviewers', 'wait_timer'].includes(rule.type),
  );
  if (blockingRules.length > 0) {
    throw new Error(`${environmentName} must not gate autonomous RC publishing`);
  }
  const policy = environment.deployment_branch_policy;
  if (policy?.protected_branches !== false || policy?.custom_branch_policies !== true) {
    throw new Error(`${environmentName} must use custom deployment branch policies`);
  }
  if (
    !Array.isArray(branchPolicies) ||
    branchPolicies.length !== 1 ||
    branchPolicies[0]?.name !== 'main'
  ) {
    throw new Error(`${environmentName} must allow exactly the main branch`);
  }
}
