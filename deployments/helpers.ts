import { ethers } from "hardhat";
// This helper isn't used by tests in CI after refactor; remove typechain import to avoid TS path issues
// Keeping the file for deploy scripts that may import it, but minimizing types to plain any
import { Signer } from "ethers";

export async function deployDepositRateManagerRegistryV1(signer: Signer): Promise<any> {
  const factory = await ethers.getContractFactory("DepositRateManagerRegistryV1", signer);
  return (await factory.deploy()) as DepositRateManagerRegistryV1;
}

export async function deployRateManagerDepositHookMock(signer: Signer): Promise<any> {
  const factory = await ethers.getContractFactory("RateManagerDepositHookMock", signer);
  return (await factory.deploy()) as RateManagerDepositHookMock;
}

export async function createRateManagerAndGetId(
  registry: any,
  config: any,
  signer?: Signer
): Promise<string> {
  const connected = signer ? registry.connect(signer) : registry;
  const tx = await connected.createRateManager(config);
  const receipt = await tx.wait();
  const ev = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
  return ev?.args?.rateManagerId;
}
