import { BigNumber, ethers } from "ethers";
import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { FX_RATE_FEEDS, FX_RATE_UPDATER, MULTI_SIG } from "../deployments/parameters";
import { waitForDeploymentDelay } from "../deployments/helpers";

export const TAG = "44_deploy_fx_rate_feeds";
export const LIVE_FLAG = "ENABLE_BASE_FX_RATE_FEEDS_DEPLOYMENT";
export const STORE_DEPLOYMENT_NAME = "FxRateStore";

type Feed = (typeof FX_RATE_FEEDS)[number];

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function feedId(pair: string): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(pair));
}

export function resolveUpdater(network: string, accounts: readonly string[]): string {
  if (network === "base") {
    const address = FX_RATE_UPDATER.base;
    if (!ethers.utils.isAddress(address) || sameAddress(address, ethers.constants.AddressZero)) {
      throw new Error("FX_RATE_UPDATER.base is not set");
    }
    return ethers.utils.getAddress(address);
  }
  if (network === "localhost" || network === "hardhat") {
    if (!accounts[1]) throw new Error("Local updater accounts[1] is missing");
    return ethers.utils.getAddress(accounts[1]);
  }
  throw new Error(`Unsupported FX rate feeds network: ${network}`);
}

export function resolveGovernance(network: string, deployer: string): string {
  return MULTI_SIG[network] || deployer;
}

export function parseSeed(network: string, feed: Feed, env: NodeJS.ProcessEnv): number {
  if (network === "localhost" || network === "hardhat") return feed.localSeed;
  if (network !== "base") throw new Error(`Unsupported FX rate feeds network: ${network}`);
  const value = env[feed.seedEnv];
  // Reject whitespace, signs, exponents and decimal/hex notation before conversion.
  if (!value || /[^0-9]/.test(value)) {
    throw new Error(`${feed.seedEnv} must be a base-10 integer within feed limits`);
  }
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < feed.minAnswer || seed > feed.maxAnswer) {
    throw new Error(`${feed.seedEnv} must be within [${feed.minAnswer}, ${feed.maxAnswer}]`);
  }
  return seed;
}

async function assertOwner(contract: Contract, deployer: string, governance: string, name: string): Promise<string> {
  const owner: string = await contract.owner();
  if (!sameAddress(owner, deployer) && !sameAddress(owner, governance)) {
    throw new Error(`${name} owner mismatch: ${owner}`);
  }
  return owner;
}

async function assertFacade(contract: Contract, storeAddress: string, feed: Feed): Promise<void> {
  if (!sameAddress(await contract.source(), storeAddress)) {
    throw new Error(`${feed.deploymentName} source mismatch`);
  }
  if ((await contract.sourceFeedId()) !== feedId(feed.pair)) {
    throw new Error(`${feed.deploymentName} sourceFeedId mismatch`);
  }
  if ((await contract.description()) !== feed.description) {
    throw new Error(`${feed.deploymentName} description mismatch`);
  }
}

export async function deployFxRateFeeds(hre: HardhatRuntimeEnvironment): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (network === "base" && process.env[LIVE_FLAG] !== "true") {
    throw new Error(`${LIVE_FLAG}=true required`);
  }
  const accounts = await hre.getUnnamedAccounts();
  const deployer = accounts[0];
  const updater = resolveUpdater(network, accounts);
  const governance = resolveGovernance(network, deployer);
  if (!ethers.utils.isAddress(governance) || sameAddress(governance, ethers.constants.AddressZero)) {
    throw new Error("FX rate feeds governance is not a nonzero address");
  }
  const signer = await hre.ethers.getSigner(deployer);

  async function existingContract(name: string, artifact: string): Promise<Contract | null> {
    const existing = await hre.deployments.getOrNull(name);
    if (!existing) return null;
    if ((await hre.ethers.provider.getCode(existing.address)) === "0x") {
      throw new Error(`${name} has no runtime code`);
    }
    const contract = await hre.ethers.getContractAt(artifact, existing.address, signer);
    await assertOwner(contract, deployer, governance, name);
    return contract;
  }

  // Read and validate the entire existing surface before the first transaction.
  let store = await existingContract(STORE_DEPLOYMENT_NAME, "FxRateStore");
  if (store && !sameAddress(await store.updater(), updater)) {
    throw new Error("FxRateStore updater drift");
  }
  const storeOwner: string = store ? await store.owner() : deployer;
  const plans: Array<{
    feed: Feed;
    id: string;
    registered: boolean;
    seed: number | undefined;
    facade: Contract | null;
  }> = [];
  for (const feed of FX_RATE_FEEDS) {
    const id = feedId(feed.pair);
    const config = store ? await store.getFeedConfig(id) : null;
    const registered = config?.registered === true;
    if (registered) {
      if (!BigNumber.from(config.minAnswer).eq(feed.minAnswer) || !BigNumber.from(config.maxAnswer).eq(feed.maxAnswer)) {
        throw new Error(`${feed.pair} limits mismatch`);
      }
    } else if (!sameAddress(storeOwner, deployer)) {
      throw new Error(`${feed.pair} unregistered and deployer is not owner`);
    }
    let seed: number | undefined;
    if (!registered || config.locked) {
      if (!sameAddress(storeOwner, deployer)) {
        throw new Error(`${feed.pair} feed locked and deployer is not owner — Safe must seed`);
      }
      seed = parseSeed(network, feed, process.env);
    } else {
      const round = await store!.latestRoundData(id);
      if (!BigNumber.from(round.answer).gt(0) || !BigNumber.from(round.updatedAt).gt(0)) {
        throw new Error(`${feed.pair} feed unlocked without a round`);
      }
    }
    const facade = await existingContract(feed.deploymentName, "FxRateFeed");
    if (facade) {
      if (!store) throw new Error(`${feed.deploymentName} source store deployment is missing`);
      await assertFacade(facade, store.address, feed);
    }
    plans.push({ feed, id, registered, seed, facade });
  }

  async function deploy(name: string, artifact: string, args: unknown[]): Promise<Contract> {
    const result = await hre.deployments.deploy(name, { contract: artifact, from: deployer, args, log: true });
    await waitForDeploymentDelay(hre);
    console.log(`[${TAG}] Deployed ${name} at ${result.address}`);
    return hre.ethers.getContractAt(artifact, result.address, signer);
  }

  async function transact(transaction: Promise<ethers.ContractTransaction>, action: string): Promise<void> {
    await (await transaction).wait();
    await waitForDeploymentDelay(hre);
    console.log(`[${TAG}] ${action}`);
  }

  if (!store) store = await deploy(STORE_DEPLOYMENT_NAME, "FxRateStore", [updater]);
  for (const plan of plans) {
    if (!plan.registered) {
      await transact(store.addFeed(plan.id, plan.feed.minAnswer, plan.feed.maxAnswer), `Added ${plan.feed.pair}`);
    }
  }
  for (const plan of plans) {
    if (plan.seed !== undefined) {
      await transact(store.seedFeed(plan.id, plan.seed), `Seeded ${plan.feed.pair} with ${plan.seed}`);
    }
  }
  for (const plan of plans) {
    if (!plan.facade) {
      plan.facade = await deploy(plan.feed.deploymentName, "FxRateFeed", [store.address, plan.id, plan.feed.description]);
      await assertFacade(plan.facade, store.address, plan.feed);
    }
  }
  const contracts = [
    { name: STORE_DEPLOYMENT_NAME, contract: store },
    ...plans.map((plan) => ({ name: plan.feed.deploymentName, contract: plan.facade! })),
  ];
  for (const { name, contract } of contracts) {
    const owner = await assertOwner(contract, deployer, governance, name);
    if (sameAddress(owner, deployer) && !sameAddress(governance, deployer)) {
      await transact(contract.transferOwnership(governance), `Transferred ${name} ownership to ${governance}`);
    }
    if (!sameAddress(await contract.owner(), governance)) throw new Error(`${name} owner mismatch after transfer`);
  }
  console.log(`[${TAG}] Verified FxRateStore + INR/USD and CNY/USD feeds; owner ${governance}`);
}

const func: DeployFunction = deployFxRateFeeds;
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return false;
  return network !== "base" || process.env.DEPLOY_ACTIVE_TAG !== TAG;
};
func.tags = [TAG, "FxRateFeeds"];
export default func;
