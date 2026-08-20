import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

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
  predecessor: { address: string; runtimeCodeHash: string };
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
  const expected = sameAddress(
    snapshot.currentHook,
    snapshot.predecessor.address
  )
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
  if (network !== "base" && network !== "base_staging") return false;
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
  const matched =
    sameAddress(currentHook, predecessor.activeLifecycleHook.address) ||
    (successorDeployment &&
      sameAddress(currentHook, successorDeployment.address));
  if (!matched) return false;

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
  let successor: { address: string; runtimeCodeHash: string } | undefined;
  if (
    successorDeployment &&
    !sameAddress(
      successorDeployment.address,
      predecessor.activeLifecycleHook.address
    )
  ) {
    if (typeof successorDeployment.deployedBytecode !== "string") {
      throw new Error(
        "Managed successor lifecycle hook lacks deployment bytecode evidence"
      );
    }
    successor = {
      address: successorDeployment.address,
      runtimeCodeHash: ethers.utils.keccak256(
        successorDeployment.deployedBytecode
      ),
    };
  }
  return validateManagedDisputeHookSnapshot({
    currentHook,
    predecessor: predecessor.activeLifecycleHook,
    successor,
    actualRuntimeCodeHash: ethers.utils.keccak256(runtimeCode),
    actualOrchestratorRegistry: await hook.orchestratorRegistry(),
    expectedOrchestratorRegistry: orchestratorRegistry.address,
    actualWhitelistPolicy: await hook.whitelistPolicy(),
    expectedWhitelistPolicy: whitelistPolicy.address,
  });
}
