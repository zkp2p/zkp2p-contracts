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
import { upv4RoutesActive } from "../../deploy/47_deploy_unified_payment_verifier_v4";

const historicalLane = require("../../deploy/31_deploy_v3_payment_binding_stack").default as
  DeployFunction & { skip: (hre: HardhatRuntimeEnvironment) => Promise<boolean> };

async function verifyLiveRegistrySurface(
  hre: HardhatRuntimeEnvironment, routedVerifier: string, governance: string,
): Promise<void> {
  const network = hre.deployments.getNetworkName();
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
  assert.equal((await registry.owner()).toLowerCase(), governance.toLowerCase(), "Payment registry owner mismatch");
  assert.equal((await legacy.owner()).toLowerCase(), governance.toLowerCase(), "Legacy nullifier registry owner mismatch");

  // Base Safe nonces 84 and 85 appended X Money and Monobank. Local catalogs stay unchanged.
  const methods = network === "base" ? getActivePaymentMethods(network) : RATIFIED_PAYMENT_METHOD_ORDER.base_staging;
  assert.deepEqual(await registry.getPaymentMethods(), methods.map(ethers.utils.id),
    "Payment registry method order mismatch");
  for (const name of methods) {
    const method = ethers.utils.id(name);
    assert.deepEqual(await registry.getCurrencies(method), RATIFIED_PAYMENT_METHOD_CURRENCIES[name].map(ethers.utils.id),
      `Payment currencies mismatch: ${name}`);
    assert.equal((await registry.getVerifier(method)).toLowerCase(), routedVerifier.toLowerCase(),
      `Payment verifier route mismatch: ${name}`);
  }
  assert.deepEqual(await legacy.getWriters(), [], "Retired legacy nullifier writers remain");
}

async function verifyLivePaymentBinding(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const upv4Active = await upv4RoutesActive(hre);
  const network = hre.deployments.getNetworkName();
  if (network !== "base" && network !== "base_staging") return upv4Active;

  if (upv4Active) {
    try {
      if ((await assertPaymentBindingReady(hre)) !== true) {
        throw new Error("Live payment-binding artifacts are missing");
      }
    } catch (error) {
      // The SHA-256-pinned lane 31 checks writers last, immediately before returning true.
      // Only this exact error proves all earlier frozen checks passed; upv4RoutesActive checks the new writer set.
      if (!(error instanceof Error) ||
        error.message !== "NullifierRegistryV2 writers must contain only UnifiedPaymentVerifierV3") throw error;
    }
    const record = await hre.deployments.get("UnifiedPaymentVerifierV4");
    const verifier = new ethers.Contract(record.address, record.abi, ethers.provider);
    const governance: string = await verifier.owner();
    await verifyLiveRegistrySurface(hre, record.address, governance);
    const nullifiers = await ethers.getContractAt(
      "NullifierRegistryV2", (await hre.deployments.get("NullifierRegistryV2")).address
    );
    assert.equal((await nullifiers.owner()).toLowerCase(), governance.toLowerCase(), "Nullifier registry V2 owner mismatch");
    return true;
  }

  // Reuse the frozen runtime, governance, witness and replay-domain checks.
  assert.ok(await assertPaymentBindingReady(hre), "Live payment-binding artifacts are missing");
  const verifier = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3", (await hre.deployments.get("UnifiedPaymentVerifierV3")).address
  );
  await verifyLiveRegistrySurface(hre, verifier.address, await verifier.owner());
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
