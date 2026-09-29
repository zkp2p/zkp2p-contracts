import "module-alias/register";

import { ethers } from "hardhat";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  savePaymentMethodSnapshot,
} from "../deployments/helpers";
import { XMONEY_PROVIDER_CONFIG } from "../deployments/verifiers/xmoney";
import { paymentBindingCutoverReady } from "./31_deploy_v3_payment_binding_stack";

const TAG = "43_add_xmoney_payment_method";
const PREPARE_FLAG = "PREPARE_STAGING_XMONEY_PAYMENT_METHOD";
const EXECUTE_FLAG = "EXECUTE_STAGING_XMONEY_PAYMENT_METHOD";

async function skip(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  if (process.env.DEPLOY_ACTIVE_TAG !== TAG) return true;
  if (hre.deployments.getNetworkName() !== "base_staging") return true;
  const prepare = process.env[PREPARE_FLAG] === "true";
  const execute = process.env[EXECUTE_FLAG] === "true";
  if (prepare === execute) {
    throw new Error(`Set exactly one of ${PREPARE_FLAG} or ${EXECUTE_FLAG}=true`);
  }
  return false;
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (await skip(hre)) return;
  if (!(await paymentBindingCutoverReady(hre, "xmoney"))) {
    throw new Error("X Money staging payment binding is not ready");
  }
  const verifier = await ethers.getContractAt(
    "UnifiedPaymentVerifierV3",
    (await hre.deployments.get("UnifiedPaymentVerifierV3")).address
  );
  const registry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    (await hre.deployments.get("PaymentVerifierRegistry")).address
  );
  const [deployer] = await hre.getUnnamedAccounts();
  if (deployer.toLowerCase() !== (await registry.owner()).toLowerCase()) {
    throw new Error("X Money activation signer is not the staging owner");
  }
  const { paymentMethodHash, currencies } = XMONEY_PROVIDER_CONFIG;
  if (!(await verifier.isPaymentMethod(paymentMethodHash))) {
    await verifier.callStatic.addPaymentMethod(paymentMethodHash);
  }
  if (!(await registry.isPaymentMethod(paymentMethodHash))) {
    await registry.callStatic.addPaymentMethod(paymentMethodHash, verifier.address, currencies);
  }
  console.log("X Money staging plan verified:", paymentMethodHash, currencies);
  if (process.env[PREPARE_FLAG] === "true") return;

  await addPaymentMethodToUnifiedVerifier(hre, verifier, paymentMethodHash);
  await addPaymentMethodToRegistry(hre, registry, paymentMethodHash, verifier.address, currencies);

  if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error("X Money staging activation verification failed");
  }
  savePaymentMethodSnapshot("base_staging", "xmoney", XMONEY_PROVIDER_CONFIG);
};

func.skip = skip;
func.tags = [TAG];

export default func;
