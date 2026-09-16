import type { DeployFunction } from "hardhat-deploy/types";
import { withHistoricalDisputeArtifacts } from "../historicalDisputeArtifacts";
import historicalLane from "../../deploy/42_retire_dispute_risk_windows";

const func: DeployFunction = (hre) => withHistoricalDisputeArtifacts(hre, () => historicalLane(hre));
const historicalSkip = historicalLane.skip;
if (!historicalSkip) throw new Error("Historical lane skip missing");
func.skip = (hre) => withHistoricalDisputeArtifacts(hre, () => historicalSkip(hre));
func.tags = ["42_retire_dispute_risk_windows", "DisputeRiskWindowRetirement"];
func.dependencies = ["39_deploy_method_scoped_vault_stack"];
export default func;
