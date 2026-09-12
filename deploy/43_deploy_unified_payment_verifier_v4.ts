import "module-alias/register";

import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { assertCanonicalDeployment } from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  assertNamespacePrefix,
  bootstrapRequested,
  readBootstrapPredecessor,
  UPV4_BOOTSTRAP_TAG,
} from "../deployments/unifiedVerifierV4Bootstrap";

const NAME = "UnifiedPaymentVerifierV4";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  if (!bootstrapRequested(hre.deployments.getNetworkName())) return;
  const [deployer] = await hre.getUnnamedAccounts();
  const initial = await readBootstrapPredecessor(hre);
  const { state } = initial;
  const args = [
    state.orchestratorRegistry,
    state.nullifierRegistry,
    state.attestationVerifier,
  ];
  let record = await hre.deployments.getOrNull(NAME);
  if (!record) {
    const deployed = await hre.deployments.deploy(NAME, {
      from: deployer,
      args,
      log: true,
    });
    if (!deployed.newlyDeployed)
      throw new Error("UPV4 bootstrap did not create a fresh verifier");
    record = deployed;
    await waitForDeploymentDelay(hre);
  }

  for (;;) {
    const current = await readBootstrapPredecessor(hre);
    if (JSON.stringify(current.state) !== JSON.stringify(state)) {
      throw new Error(
        "UPV4 predecessor changed during passive bootstrap; stop and review"
      );
    }
    const at = { blockTag: current.blockNumber };
    await assertCanonicalDeployment(
      hre,
      record,
      NAME,
      NAME,
      current.blockNumber
    );
    const successor = await hre.ethers.getContractAt(
      NAME,
      record.address,
      await hre.ethers.getSigner(deployer)
    );
    const dependencies = [
      await successor.orchestratorRegistry(at),
      await successor.nullifierRegistry(at),
      await successor.attestationVerifier(at),
    ];
    if (
      dependencies.some(
        (address, index) => address.toLowerCase() !== args[index].toLowerCase()
      )
    ) {
      throw new Error("UPV4 dependency mismatch");
    }
    const domain = hre.ethers.utils._TypedDataEncoder.hashDomain({
      name: "UnifiedPaymentVerifier",
      version: "1",
      chainId: state.chainId,
      verifyingContract: record.address,
    });
    if ((await successor.DOMAIN_SEPARATOR(at)) !== domain)
      throw new Error("UPV4 signing domain mismatch");
    const methods: string[] = await successor.getPaymentMethods(at);
    const namespaces: string[] = [];
    const active: boolean[] = [];
    for (const { method } of state.entries) {
      namespaces.push(await successor.nullifierNamespace(method, at));
      active.push(await successor.isPaymentMethod(method, at));
    }
    const next = assertNamespacePrefix(
      state.entries,
      methods,
      namespaces,
      active
    );
    const owner: string = await successor.owner(at);
    if (
      next === state.entries.length &&
      owner.toLowerCase() === state.governance.toLowerCase()
    ) {
      console.log(
        "UPV4 passively prepared; live routing and writer permissions remain on UPV3",
        {
          address: record.address,
          snapshotBlock: current.blockNumber,
          snapshotBlockHash: current.blockHash,
        }
      );
      return;
    }
    if (owner.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error("UPV4 incomplete bootstrap is not owned by the deployer");
    }
    if (next < state.entries.length) {
      const { method, namespace } = state.entries[next];
      await (await successor.addPaymentMethod(method, namespace)).wait();
    } else {
      await (await successor.transferOwnership(state.governance)).wait();
    }
    await waitForDeploymentDelay(hre);
  }
};

func.skip = async (hre: HardhatRuntimeEnvironment) =>
  !bootstrapRequested(hre.deployments.getNetworkName());
func.tags = [UPV4_BOOTSTRAP_TAG];
func.dependencies = [];

export default func;
