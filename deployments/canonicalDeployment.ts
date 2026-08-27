import { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "hardhat-deploy/types";

type ImmutableReference = {
  start: number;
  length: number;
};

type ImmutableReferences = Record<string, ImmutableReference[]>;

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
  artifactName: string
): Promise<void> {
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  const code = await hre.ethers.provider.getCode(deployment.address);
  const deployedBytecode = deployment.deployedBytecode;
  const immutableReferences =
    typeof deployment.solcInputHash === "string" &&
    deployment.solcInputHash === artifact.solcInputHash
      ? (artifact.evm?.deployedBytecode?.immutableReferences as
          | ImmutableReferences
          | undefined) || {}
      : {};
  const normalizedRecord =
    typeof deployedBytecode === "string"
      ? zeroImmutableValues(deployedBytecode, immutableReferences)
      : undefined;
  const normalizedCode = zeroImmutableValues(code, immutableReferences);
  let rawBytecodeMatches = false;
  if (typeof deployedBytecode === "string" && code !== "0x") {
    try {
      rawBytecodeMatches =
        hre.ethers.utils.keccak256(deployedBytecode) ===
        hre.ethers.utils.keccak256(code);
    } catch {
      rawBytecodeMatches = false;
    }
  }
  if (
    code === "0x" ||
    normalizedRecord === undefined ||
    (normalizedRecord !== normalizedCode && !rawBytecodeMatches)
  ) {
    throw new Error(
      `${deploymentName} on-chain code does not match its deployment record`
    );
  }
}

export async function assertCanonicalDeployment(
  hre: HardhatRuntimeEnvironment,
  deployment: Deployment,
  deploymentName: string,
  artifactName: string
): Promise<void> {
  await assertDeploymentMatchesChain(
    hre,
    deployment,
    deploymentName,
    artifactName
  );
  const artifact = await hre.deployments.getExtendedArtifact(artifactName);
  const code = await hre.ethers.provider.getCode(deployment.address);
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
