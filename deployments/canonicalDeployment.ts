import { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "hardhat-deploy/types";

type ImmutableReference = {
  start: number;
  length: number;
};

type ImmutableReferences = Record<string, ImmutableReference[]>;

export function deploymentCodeMatchesRecord(
  recordBytecode: string,
  chainCode: string
): boolean {
  const bytecodePattern = /^0x(?:[0-9a-fA-F]{2})*$/;
  if (
    !bytecodePattern.test(recordBytecode) ||
    !bytecodePattern.test(chainCode) ||
    recordBytecode.length !== chainCode.length
  ) {
    return false;
  }

  for (let index = 2; index < recordBytecode.length; index += 2) {
    const recordByte = recordBytecode.slice(index, index + 2).toLowerCase();
    const chainByte = chainCode.slice(index, index + 2).toLowerCase();
    if (recordByte !== chainByte && recordByte !== "00") return false;
  }
  return true;
}

export function zeroImmutableValues(
  bytecode: string,
  immutableReferences: ImmutableReferences
): string {
  let normalized = bytecode.slice(2).toLowerCase();
  for (const references of Object.values(immutableReferences)) {
    for (const reference of references) {
      const start = reference.start * 2;
      const length = reference.length * 2;
      normalized = `${normalized.slice(0, start)}${"0".repeat(
        length
      )}${normalized.slice(start + length)}`;
    }
  }
  return `0x${normalized}`;
}

export async function assertDeploymentMatchesChain(
  hre: HardhatRuntimeEnvironment,
  deployment: Deployment,
  deploymentName: string,
  artifactName: string,
  blockTag?: string | number
): Promise<void> {
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  const code = await hre.ethers.provider.getCode(deployment.address, blockTag);
  const deployedBytecode = deployment.deployedBytecode;
  if (code === "0x" || typeof deployedBytecode !== "string") {
    throw new Error(
      `${deploymentName} on-chain code does not match its deployment record`
    );
  }

  if (deployment.solcInputHash === artifact.solcInputHash) {
    const immutableReferences =
      (artifact.evm?.deployedBytecode?.immutableReferences as
        | ImmutableReferences
        | undefined) || {};
    if (
      zeroImmutableValues(deployedBytecode, immutableReferences) !==
      zeroImmutableValues(code, immutableReferences)
    ) {
      throw new Error(
        `${deploymentName} on-chain code does not match its deployment record`
      );
    }
    return;
  }

  if (!deploymentCodeMatchesRecord(deployedBytecode, code)) {
    throw new Error(
      `${deploymentName} on-chain code does not match its deployment record`
    );
  }
}

export async function assertCanonicalDeployment(
  hre: HardhatRuntimeEnvironment,
  deployment: Deployment,
  deploymentName: string,
  artifactName: string,
  blockTag?: string | number
): Promise<void> {
  await assertDeploymentMatchesChain(
    hre,
    deployment,
    deploymentName,
    artifactName,
    blockTag
  );
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  const code = await hre.ethers.provider.getCode(deployment.address, blockTag);
  if (
    typeof deployment.deployedBytecode !== "string" ||
    typeof deployment.solcInputHash !== "string" ||
    typeof artifact.deployedBytecode !== "string" ||
    deployment.solcInputHash !== artifact.solcInputHash
  ) {
    throw new Error(`${deploymentName} lacks canonical deployment evidence`);
  }
  const immutableReferences =
    (artifact.evm?.deployedBytecode?.immutableReferences as
      | ImmutableReferences
      | undefined) || {};
  const normalized = zeroImmutableValues(code, immutableReferences);
  if (
    normalized !==
      zeroImmutableValues(deployment.deployedBytecode, immutableReferences) ||
    normalized !==
      zeroImmutableValues(artifact.deployedBytecode, immutableReferences)
  ) {
    throw new Error(
      `${deploymentName} runtime bytecode is not the canonical build`
    );
  }
}
