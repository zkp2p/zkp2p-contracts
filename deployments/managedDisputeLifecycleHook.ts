import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { zeroImmutableValues } from "./canonicalDeployment";
import { PREDECESSOR_DISPUTE_STACKS } from "./predecessorDisputeStack";

const { getActiveDisputeDeploymentName } =
  require("./activeDisputeStack.cjs") as {
    getActiveDisputeDeploymentName(
      network: string,
      canonicalName: string
    ): string;
  };

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export type ManagedHookSnapshot = {
  currentHook: string;
  predecessor?: { address: string; runtimeCodeHash: string };
  successor?: { address: string; runtimeCodeHash: string };
  actualRuntimeCodeHash: string;
  actualOrchestratorRegistry: string;
  expectedOrchestratorRegistry: string;
  actualWhitelistPolicy: string;
  expectedWhitelistPolicy: string;
};

export function validateManagedDisputeHookSnapshot(
  snapshot: ManagedHookSnapshot
): boolean {
  const expected =
    snapshot.predecessor &&
    sameAddress(snapshot.currentHook, snapshot.predecessor.address)
      ? snapshot.predecessor
      : snapshot.successor &&
        sameAddress(snapshot.currentHook, snapshot.successor.address)
      ? snapshot.successor
      : undefined;
  if (!expected) return false;
  if (snapshot.actualRuntimeCodeHash !== expected.runtimeCodeHash) {
    throw new Error("Managed dispute lifecycle hook runtime bytecode mismatch");
  }
  if (
    !sameAddress(
      snapshot.actualOrchestratorRegistry,
      snapshot.expectedOrchestratorRegistry
    )
  ) {
    throw new Error("Managed dispute lifecycle hook registry mismatch");
  }
  if (
    !sameAddress(
      snapshot.actualWhitelistPolicy,
      snapshot.expectedWhitelistPolicy
    )
  ) {
    throw new Error("Managed dispute lifecycle hook whitelist policy mismatch");
  }
  return true;
}

export async function guardManagedDisputeLifecycleHook(
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (
    network !== "base" &&
    network !== "base_staging" &&
    network !== "localhost" &&
    network !== "hardhat"
  )
    return false;
  const predecessor = PREDECESSOR_DISPUTE_STACKS[network];
  const orchestratorDeployment = await hre.deployments.getOrNull(
    "OrchestratorV3"
  );
  if (!orchestratorDeployment) return false;
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    orchestratorDeployment.address
  );
  const currentHook = await orchestrator.lifecycleHook();
  const successorName = getActiveDisputeDeploymentName(
    network,
    "IntentLifecycleHookV1"
  );
  const successorDeployment = await hre.deployments.getOrNull(successorName);
  const matchedPredecessor =
    predecessor &&
    sameAddress(currentHook, predecessor.activeLifecycleHook.address);
  const matchedSuccessor =
    successorDeployment &&
    sameAddress(currentHook, successorDeployment.address);
  if (!matchedPredecessor && !matchedSuccessor) return false;

  const runtimeCode = await ethers.provider.getCode(currentHook);
  if (runtimeCode === "0x")
    throw new Error("Managed dispute lifecycle hook has no bytecode");
  const hook = new ethers.Contract(
    currentHook,
    [
      "function orchestratorRegistry() view returns (address)",
      "function whitelistPolicy() view returns (address)",
    ],
    ethers.provider
  );
  const orchestratorRegistry = await hre.deployments.get(
    "OrchestratorRegistry"
  );
  const whitelistPolicy = await hre.deployments.get("WhitelistPolicy");
  let expectedWhitelistPolicy = whitelistPolicy.address;
  if (matchedSuccessor && !matchedPredecessor) {
    const successorArgs = successorDeployment.args;
    const successorWhitelistPolicy = successorArgs?.[1];
    if (
      !Array.isArray(successorArgs) ||
      typeof successorWhitelistPolicy !== "string" ||
      !ethers.utils.isAddress(successorWhitelistPolicy)
    ) {
      throw new Error(
        "Managed successor lifecycle hook has malformed constructor policy evidence"
      );
    }
    const methodScopedWhitelistPolicy = await hre.deployments.getOrNull(
      "WhitelistPolicyMethodScoped"
    );
    if (
      !sameAddress(successorWhitelistPolicy, whitelistPolicy.address) &&
      (!methodScopedWhitelistPolicy ||
        !sameAddress(
          successorWhitelistPolicy,
          methodScopedWhitelistPolicy.address
        ))
    ) {
      throw new Error(
        "Managed successor whitelist policy does not match a recognized deployment"
      );
    }
    expectedWhitelistPolicy = successorWhitelistPolicy;
  }
  let actualRuntimeCodeHash = ethers.utils.keccak256(runtimeCode);
  let successor: { address: string; runtimeCodeHash: string } | undefined;
  if (matchedSuccessor && !matchedPredecessor) {
    if (typeof successorDeployment.deployedBytecode !== "string") {
      throw new Error(
        "Managed successor lifecycle hook lacks deployment bytecode evidence"
      );
    }
    const artifact = await hre.deployments.getExtendedArtifact(
      "IntentLifecycleHookV1"
    );
    const artifactDeployedBytecode = artifact.evm?.deployedBytecode;
    if (!artifactDeployedBytecode) {
      throw new Error(
        "Managed successor lifecycle hook artifact lacks deployed bytecode metadata"
      );
    }
    const immutableReferences =
      artifactDeployedBytecode.immutableReferences || {};
    successor = {
      address: successorDeployment.address,
      runtimeCodeHash: ethers.utils.keccak256(
        zeroImmutableValues(
          successorDeployment.deployedBytecode,
          immutableReferences
        )
      ),
    };
    actualRuntimeCodeHash = ethers.utils.keccak256(
      zeroImmutableValues(runtimeCode, immutableReferences)
    );
  }
  return validateManagedDisputeHookSnapshot({
    currentHook,
    predecessor: predecessor?.activeLifecycleHook,
    successor,
    actualRuntimeCodeHash,
    actualOrchestratorRegistry: await hook.orchestratorRegistry(),
    expectedOrchestratorRegistry: orchestratorRegistry.address,
    actualWhitelistPolicy: await hook.whitelistPolicy(),
    expectedWhitelistPolicy,
  });
}
