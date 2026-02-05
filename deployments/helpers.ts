import { ethers } from "hardhat";
import {
  DepositRateManagerRegistryV1,
  RateManagerDepositHookMock,
  IDepositRateManagerRegistryV1,
} from "@typechain";
import { Signer } from "ethers";

export async function deployDepositRateManagerRegistryV1(signer: Signer): Promise<DepositRateManagerRegistryV1> {
  const factory = await ethers.getContractFactory("DepositRateManagerRegistryV1", signer);
  return (await factory.deploy()) as DepositRateManagerRegistryV1;
}

export async function deployRateManagerDepositHookMock(signer: Signer): Promise<RateManagerDepositHookMock> {
  const factory = await ethers.getContractFactory("RateManagerDepositHookMock", signer);
  return (await factory.deploy()) as RateManagerDepositHookMock;
}

export async function createRateManagerAndGetId(
  registry: DepositRateManagerRegistryV1,
  config: IDepositRateManagerRegistryV1.RateManagerConfigStruct,
  signer?: Signer
): Promise<string> {
  const connected = signer ? registry.connect(signer) : registry;
  const tx = await connected.createRateManager(config);
  const receipt = await tx.wait();
  const ev = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
  return ev?.args?.rateManagerId;
}

