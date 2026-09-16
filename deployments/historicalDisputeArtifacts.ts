import { readFileSync } from "fs";
import { join } from "path";
import { utils } from "ethers";
import type { Artifact, HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment, ExtendedArtifact } from "hardhat-deploy/types";
import pins from "./historical-dispute-artifacts.json";

type HistoricalName = keyof typeof pins;

export function isHistoricalDisputeArtifact(name: string): name is HistoricalName {
  return name === "DisputeProtectionPolicy" || name === "IntentLifecycleHookV1";
}

/** Executed lane-39 artifacts, used only by historical lanes and rehearsals. */
export function historicalDisputeArtifact(name: HistoricalName): Artifact & ExtendedArtifact {
  const pin = pins[name];
  const record: Deployment = JSON.parse(readFileSync(join(__dirname, "base", pin.file), "utf8"));
  if (!record.bytecode || utils.keccak256(record.bytecode) !== pin.bytecodeHash) {
    throw new Error(`Historical ${name} creation bytecode changed`);
  }
  if (!record.deployedBytecode || !record.solcInputHash) {
    throw new Error(`Historical ${name} compiler evidence missing`);
  }
  return {
    ...record,
    _format: "hh-sol-artifact-1",
    contractName: name,
    sourceName: `contracts/hooks/${name}.sol`,
    bytecode: record.bytecode,
    deployedBytecode: record.deployedBytecode,
    linkReferences: {},
    deployedLinkReferences: {},
    evm: { deployedBytecode: { immutableReferences: pin.immutableReferences } },
  };
}

/**
 * Bind an immutable lane to its executed contract artifacts for one serial invocation.
 * Restore the current artifact resolver before any successor lane runs.
 */
export async function withHistoricalDisputeArtifacts<T>(
  hre: HardhatRuntimeEnvironment,
  run: () => Promise<T>
): Promise<T> {
  const readArtifact = hre.artifacts.readArtifact;
  const getExtendedArtifact = hre.deployments.getExtendedArtifact;
  const deploy = hre.deployments.deploy;
  hre.artifacts.readArtifact = async (name) => isHistoricalDisputeArtifact(name)
    ? historicalDisputeArtifact(name)
    : readArtifact.call(hre.artifacts, name);
  hre.deployments.getExtendedArtifact = async (name) => isHistoricalDisputeArtifact(name)
    ? historicalDisputeArtifact(name)
    : getExtendedArtifact.call(hre.deployments, name);
  hre.deployments.deploy = (name, options) => {
    const contract = options.contract === undefined ? name : options.contract;
    return deploy.call(hre.deployments, name, typeof contract === "string" && isHistoricalDisputeArtifact(contract)
      ? { ...options, contract: historicalDisputeArtifact(contract) }
      : options);
  };
  try {
    return await run();
  } finally {
    hre.artifacts.readArtifact = readArtifact;
    hre.deployments.getExtendedArtifact = getExtendedArtifact;
    hre.deployments.deploy = deploy;
  }
}
