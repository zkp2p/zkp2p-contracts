import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type DeploymentMap = Record<string, any>;

export function selectVerificationDeployments(
  deployments: DeploymentMap,
  allowlist?: string[],
): DeploymentMap {
  if (!allowlist || allowlist.length === 0) return deployments;
  const selected: DeploymentMap = {};
  for (const name of allowlist) {
    if (!Object.prototype.hasOwnProperty.call(deployments, name)) {
      throw new Error(`Unknown deployment name: ${name}`);
    }
    selected[name] = deployments[name];
  }
  return selected;
}

export async function verifyDeployments(
  hre: Pick<HardhatRuntimeEnvironment, 'run'>,
  deployments: DeploymentMap,
  delayMs: number,
  failOnError: boolean,
): Promise<{ verified: string[]; failed: { name: string; error: string }[]; skipped: string[] }> {
  const contractNames = Object.keys(deployments);
  console.log(`Found ${contractNames.length} contracts to verify`);
  console.log(`Using ${delayMs}ms delay between verifications`);
  const results = {
    verified: [] as string[],
    failed: [] as { name: string; error: string }[],
    skipped: [] as string[],
  };

  for (let index = 0; index < contractNames.length; index += 1) {
    const contractName = contractNames[index];
    const deployment = deployments[contractName];
    console.log(`\nVerifying ${contractName} (${deployment.address}) [${index + 1}/${contractNames.length}]...`);
    try {
      await hre.run('verify:verify', {
        address: deployment.address,
        constructorArguments: deployment.args || [],
        libraries: deployment.libraries || {},
      });
      console.log(`✅ Contract ${contractName} is now verified`);
      results.verified.push(contractName);
    } catch (error: any) {
      if (String(error.message).toLowerCase().includes('already verified')) {
        console.log(`⏭️  Contract ${contractName} already verified`);
        results.skipped.push(contractName);
      } else {
        console.error(`❌ Contract ${contractName} failed to verify: ${error.message}`);
        results.failed.push({ name: contractName, error: error.message });
      }
    }
    if (index < contractNames.length - 1) await sleep(delayMs);
  }

  console.log('\n========== Verification Summary ==========');
  console.log(`✅ Verified: ${results.verified.length}`);
  console.log(`⏭️  Skipped (already verified): ${results.skipped.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  if (results.failed.length > 0) {
    console.log('\nFailed verifications:');
    results.failed.forEach(({ name, error }) => console.log(`  - ${name}: ${error}`));
  }
  if (failOnError && results.failed.length > 0) {
    throw new Error(`${results.failed.length} selected contract verification(s) failed`);
  }
  return results;
}

task('etherscan-verify-with-delay', 'Verify contracts on Etherscan with delays to avoid rate limiting')
  .addOptionalParam('delay', 'Delay in milliseconds between verifications', '600')
  .addOptionalParam('contracts', 'Comma-separated deployment names to verify')
  .addFlag('failOnError', 'Fail after the summary when any selected verification fails')
  .setAction(async ({ delay, contracts, failOnError }, hre: HardhatRuntimeEnvironment) => {
    const delayMs = Number(delay);
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error(`Invalid verification delay: ${delay}`);
    const allowlist = contracts
      ? String(contracts).split(',').map((name) => name.trim()).filter(Boolean)
      : undefined;
    const deployments = selectVerificationDeployments(await hre.deployments.all(), allowlist);
    await verifyDeployments(hre, deployments, delayMs, failOnError);
  });
