import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const historicalLane =
  require("../../deploy/37_deploy_method_scoped_dispute_lifecycle_stack")
    .default as DeployFunction;

const LOCAL_NETWORKS = new Set(["localhost", "hardhat"]);

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  if (!LOCAL_NETWORKS.has(network)) {
    throw new Error("Lane 37 is retired on live networks; local networks only");
  }
  await historicalLane(hre);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!LOCAL_NETWORKS.has(network)) return true;
  return (await historicalLane.skip?.(hre)) ?? false;
};

func.tags = [
  "37_deploy_method_scoped_dispute_lifecycle_stack",
  "V3DisputeMethodScopedStack",
];
func.dependencies = [];

export default func;
