import * as assert from "node:assert/strict";
import { ethers } from "hardhat";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import {
  assertPaymentBindingReady,
  RATIFIED_PAYMENT_METHOD_CURRENCIES,
  RATIFIED_PAYMENT_METHOD_ORDER,
} from "../../deploy/31_deploy_v3_payment_binding_stack";
import { getActivePaymentMethods } from "../parameters";

const historicalLane = require("../../deploy/31_deploy_v3_payment_binding_stack").default as
  DeployFunction & { skip: (hre: HardhatRuntimeEnvironment) => Promise<boolean> };

async function verifyLivePaymentBinding(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const network = hre.deployments.getNetworkName();
  if (network !== "base" && network !== "base_staging") return false;

  // Reuse the frozen runtime, governance, witness and replay-domain checks.
  assert.ok(await assertPaymentBindingReady(hre), "Live payment-binding artifacts are missing");
  const verifier = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3", (await hre.deployments.get("UnifiedPaymentVerifierV3")).address
  );
  const registry = await ethers.getContractAt(
    "PaymentVerifierRegistry", (await hre.deployments.get("PaymentVerifierRegistry")).address
  );
  const legacy = await ethers.getContractAt(
    "NullifierRegistry", (await hre.deployments.get("NullifierRegistry")).address
  );
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3", (await hre.deployments.get("OrchestratorV3")).address
  );
  assert.equal(registry.address.toLowerCase(), (await orchestrator.paymentVerifierRegistry()).toLowerCase(),
    "Payment registry target address mismatch");
  const governance = (await verifier.owner()).toLowerCase();
  assert.equal((await registry.owner()).toLowerCase(), governance, "Payment registry owner mismatch");
  assert.equal((await legacy.owner()).toLowerCase(), governance, "Legacy nullifier registry owner mismatch");

  // Base Safe nonces 84 and 85 appended X Money and Monobank. Local catalogs stay unchanged.
  const methods = network === "base" ? getActivePaymentMethods(network) : RATIFIED_PAYMENT_METHOD_ORDER.base_staging;
  assert.deepEqual(await registry.getPaymentMethods(), methods.map(ethers.utils.id),
    "Payment registry method order mismatch");
  for (const name of methods) {
    const method = ethers.utils.id(name);
    assert.deepEqual(await registry.getCurrencies(method), RATIFIED_PAYMENT_METHOD_CURRENCIES[name].map(ethers.utils.id),
      `Payment currencies mismatch: ${name}`);
    assert.equal((await registry.getVerifier(method)).toLowerCase(), verifier.address.toLowerCase(),
      `Payment verifier route mismatch: ${name}`);
  }
  assert.deepEqual(await legacy.getWriters(), [], "Retired legacy nullifier writers remain");
  return true;
}

const func: DeployFunction = async (hre) => {
  if (await verifyLivePaymentBinding(hre)) return;
  await historicalLane(hre);
};

func.skip = async (hre) => {
  if (await verifyLivePaymentBinding(hre)) return true;
  return historicalLane.skip(hre);
};
func.tags = historicalLane.tags;

export default func;
