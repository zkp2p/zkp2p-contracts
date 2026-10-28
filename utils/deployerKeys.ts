import { Wallet } from "ethers";

// Compromised 2026-10-28; these signers must never be used again.
export const RETIRED_DEPLOYERS: readonly string[] = [
  "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
];

export function getDeployerAccounts(
  env: Record<string, string | undefined>,
  retiredDeployers: readonly string[] = RETIRED_DEPLOYERS
): { base: string[]; base_staging: string[]; goerli: string[] } {
  if (env.BASE_DEPLOY_PRIVATE_KEY !== undefined) {
    throw new Error("BASE_DEPLOY_PRIVATE_KEY is retired; delete it and use BASE_DEPLOYER_KEY");
  }

  function accounts(envVar: string): string[] {
    const value = env[envVar];
    if (!value) return [];
    const key = `0x${value.replace(/^0x/, "")}`;
    let address: string;
    try {
      address = new Wallet(key).address;
    } catch {
      throw new Error(`${envVar} private key is invalid`);
    }
    if (retiredDeployers.some((retired) => retired.toLowerCase() === address.toLowerCase())) {
      throw new Error(`${envVar} signer is retired`);
    }
    return [key];
  }

  const base = accounts("BASE_DEPLOYER_KEY");
  const escrowVanity = accounts("VANITY_ESCROW_V2_PROD_PRIVATE_KEY");
  const orchestratorVanity = accounts("VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY");
  return {
    base: base.length ? [...base, ...escrowVanity, ...orchestratorVanity] : [],
    base_staging: accounts("STAGING_DEPLOYER_KEY"),
    goerli: accounts("TESTNET_DEPLOY_PRIVATE_KEY"),
  };
}
