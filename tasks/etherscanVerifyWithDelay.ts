import { task } from 'hardhat/config';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

task('etherscan-verify-with-delay', 'Verify contracts on Etherscan with delays to avoid rate limiting')
  .addOptionalParam('delay', 'Delay in milliseconds between verifications', '600')
  .setAction(async ({ delay }, hre: HardhatRuntimeEnvironment) => {
    const delayMs = parseInt(delay);
    const deployments = await hre.deployments.all();
    const contractNames = Object.keys(deployments);

    console.log(`Found ${contractNames.length} contracts to verify`);
    console.log(`Using ${delayMs}ms delay between verifications`);

    const results = {
      verified: [] as string[],
      failed: [] as { name: string; error: string }[],
      skipped: [] as string[]
    };

    for (let i = 0; i < contractNames.length; i++) {
      const contractName = contractNames[i];
      const deployment = deployments[contractName];

      console.log(`\nVerifying ${contractName} (${deployment.address}) [${i + 1}/${contractNames.length}]...`);

      try {
        await hre.run('verify:verify', {
          address: deployment.address,
          constructorArguments: deployment.args || [],
          libraries: deployment.libraries || {},
        });

        console.log(`✅ Contract ${contractName} is now verified`);
        results.verified.push(contractName);
      } catch (error: any) {
        if (error.message.includes('already verified')) {
          console.log(`⏭️  Contract ${contractName} already verified`);
          results.skipped.push(contractName);
        } else {
          console.error(`❌ Contract ${contractName} failed to verify: ${error.message}`);
          results.failed.push({ name: contractName, error: error.message });
        }
      }

      // Add delay between verifications (except for the last one)
      if (i < contractNames.length - 1) {
        console.log(`Waiting ${delayMs}ms before next verification...`);
        await sleep(delayMs);
      }
    }

    // Summary
    console.log('\n========== Verification Summary ==========');
    console.log(`✅ Verified: ${results.verified.length}`);
    console.log(`⏭️  Skipped (already verified): ${results.skipped.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);

    if (results.failed.length > 0) {
      console.log('\nFailed verifications:');
      results.failed.forEach(({ name, error }) => {
        console.log(`  - ${name}: ${error}`);
      });
    }
  });
