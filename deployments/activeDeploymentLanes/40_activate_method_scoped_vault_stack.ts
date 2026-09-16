import type { DeployFunction } from "hardhat-deploy/types";
import { withHistoricalDisputeArtifacts } from "../historicalDisputeArtifacts";
import historicalLane from "../../deploy/40_activate_method_scoped_vault_stack";

const func: DeployFunction = (hre) => withHistoricalDisputeArtifacts(hre, () => historicalLane(hre));
const historicalSkip = historicalLane.skip;
if (!historicalSkip) throw new Error("Historical lane skip missing");
func.skip = (hre) => withHistoricalDisputeArtifacts(hre, () => historicalSkip(hre));
func.tags = ["40_activate_method_scoped_vault_stack", "V3DisputeMethodScopedVaultActivation"];
func.dependencies = [];
export default func;
