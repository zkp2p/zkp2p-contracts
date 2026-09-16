import type { DeployFunction } from "hardhat-deploy/types";
import { withHistoricalDisputeArtifacts } from "../historicalDisputeArtifacts";
import { guardManagedDisputeLifecycleHook } from "../managedDisputeLifecycleHook";
import historicalLane from "../../deploy/39_deploy_method_scoped_vault_stack";

const func: DeployFunction = async (hre) => {
  if (await currentLocalPolicyActive(hre)) return;
  await withHistoricalDisputeArtifacts(hre, () => historicalLane(hre));
};

async function currentLocalPolicyActive(hre: Parameters<DeployFunction>[0]): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  return (network === "localhost" || network === "hardhat") && await guardManagedDisputeLifecycleHook(hre);
}
const historicalSkip = historicalLane.skip;
if (!historicalSkip) throw new Error("Historical lane skip missing");
func.skip = async (hre) => await currentLocalPolicyActive(hre)
  || withHistoricalDisputeArtifacts(hre, () => historicalSkip(hre));
func.tags = ["39_deploy_method_scoped_vault_stack", "V3DisputeMethodScopedVaultStack"];
func.dependencies = [];
export default func;
