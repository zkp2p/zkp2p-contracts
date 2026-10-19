import { utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "hardhat-deploy/types";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "./canonicalDeployment";
import { RATIFIED_PAYMENT_METHOD_CURRENCIES } from "../deploy/31_deploy_v3_payment_binding_stack";

export type O4Network = "base" | "base_staging";
export const LANE_45_TAG = "45_deploy_orchestrator_v4_stack";
export const LANE_46_TAG = "46_activate_orchestrator_v4_stack";

// Record order follows the resumable deployment steps, not the artifact table.
export const O4_DEPLOYMENT_NAMES = [
  "StakeVaultV2",
  "WhitelistPolicyV4",
  "DisputeProtectionPolicyV2",
  "UnifiedPaymentVerifierV4",
  "OrchestratorV4",
] as const;
export type O4DeploymentName = (typeof O4_DEPLOYMENT_NAMES)[number];
export const O4_ARTIFACT_NAMES: Record<O4DeploymentName, string> = {
  StakeVaultV2: "StakeVaultV2",
  WhitelistPolicyV4: "WhitelistPolicy",
  DisputeProtectionPolicyV2: "DisputeProtectionPolicyV2",
  UnifiedPaymentVerifierV4: "UnifiedPaymentVerifierV4",
  OrchestratorV4: "OrchestratorV4",
};
/** Each network's recording PR adds its pins after lane 45 runs there. */
export const O4_RECORDED_DEPLOYMENTS: Partial<
  Record<O4Network, Record<O4DeploymentName, ContractPin>>
> = {};

/** A record's solcInputHash depends on the deploying checkout's build cache
 * history, so it cannot gate later verification from a clean build. Recorded
 * deployments use address and runtime pins; unrecorded ones stay canonical. */
export async function assertO4DeploymentRecord(
  hre: HardhatRuntimeEnvironment,
  network: string,
  name: O4DeploymentName,
  record: Deployment,
  blockTag?: string | number
): Promise<void> {
  await assertDeploymentMatchesChain(
    hre,
    record,
    name,
    O4_ARTIFACT_NAMES[name],
    blockTag
  );
  const pin = isO4LiveNetwork(network)
    ? O4_RECORDED_DEPLOYMENTS[network]?.[name]
    : undefined;
  if (pin) {
    if (record.address.toLowerCase() !== pin.address.toLowerCase()) {
      throw new Error(`${name} deployment address mismatch`);
    }
    const code = await hre.ethers.provider.getCode(record.address, blockTag);
    if (utils.keccak256(code) !== pin.runtimeCodeHash) {
      throw new Error(`${name} runtime bytecode hash mismatch`);
    }
  } else {
    await assertCanonicalDeployment(
      hre,
      record,
      name,
      O4_ARTIFACT_NAMES[name],
      blockTag
    );
  }
}

export const O4_PREDECESSOR_DEPLOYMENT_NAMES = {
  vault: "StakeVaultMethodScoped",
  policy: "DisputeProtectionPolicyMethodScopedStaked",
  hook: "IntentLifecycleHookV1MethodScopedStaked",
} as const;

export type ContractPin = { address: string; runtimeCodeHash: string };
export type O4LivePins = {
  retainedDisputeWriters: string[];
  allowMultipleIntents: boolean;
  chainId: number;
  deployer: string;
  stakeToken: string;
  governance: string;
  escrow: string;
  // Retired by lane 46: every payment route moves from UPV3 to the fresh UPV4.
  unifiedPaymentVerifierV3: ContractPin;
  paymentVerifierRegistry: ContractPin;
  disputeVerifier: ContractPin;
  disputeNullifierRegistry: ContractPin;
  // O3 keeps this instance; lane 45 only reuses its constructor dependencies for O4.
  whitelistPolicy: ContractPin;
  predecessorVault: ContractPin;
  predecessorPolicy: ContractPin;
  // O3's lifecycle hook before and after the cutover.
  predecessorHook: ContractPin;
  paymentMethods: string[];
  predecessorRiskWindows: Record<string, string>;
  predecessorControllerChangeDelay: string;
  allowedWhitelistPolicyOwners: string[];
};

// Both networks were read at Base block 52,810,000.
export const O4_EXPECTED_LIVE: Record<O4Network, O4LivePins> = {
  base: {
    chainId: 8453,
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    stakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    governance: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    escrow: "0x777777779d229cdF3110e9de47943791c26300Ef",
    unifiedPaymentVerifierV3: {
      address: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
      runtimeCodeHash:
        "0x7636c79f0f46cf88c7122767e553264f1898fa253ea214f6a1c3187b0f0a4bcf",
    },
    paymentVerifierRegistry: {
      address: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
      runtimeCodeHash:
        "0xf8b2a3d222990397e047e7e4f1afe45ecfabe0a9d04be7b5e97e5a1755026e36",
    },
    disputeVerifier: {
      address: "0x30d4947f005653637005eed991005119D9eB2f34",
      runtimeCodeHash:
        "0x65246e11392befc33d92246cf3ac2467d1f338a8b73c6514b76fab0a70a01ead",
    },
    disputeNullifierRegistry: {
      address: "0xA845615b5203F7a21321DdF5e3a1ca024D93a443",
      runtimeCodeHash:
        "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
    },
    whitelistPolicy: {
      address: "0x389Cd9bA91FfFcd83d267B241E975541892759Ce",
      runtimeCodeHash:
        "0xa83d138a5b89d2fd2861702febc6333e542dcdc8994ee76c345dcbd22fe685a4",
    },
    predecessorVault: {
      address: "0x47c26258222e2f96424bD2B21bf173f0DA5034C7",
      runtimeCodeHash:
        "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
    },
    predecessorPolicy: {
      address: "0xbF4B769dB70DBEc89b6b2c44988304a7aD2de4Fc",
      runtimeCodeHash:
        "0xf5a7756f16556da69c91c55bdcffd9fd95cc8cbdb772699827ec4c66db136dfe",
    },
    predecessorHook: {
      address: "0x5Dd6C675a7406fE8C9f0D93394a36fd6e8c50031",
      runtimeCodeHash:
        "0x2b479a570ddea7a990f2cae8fa95eb3b8599fc8b367332b8dab92f7d0cebf7e0",
    },
    retainedDisputeWriters: ["0xbF4B769dB70DBEc89b6b2c44988304a7aD2de4Fc"],
    allowMultipleIntents: true,
    paymentMethods: [
      "alipay",
      "chime",
      "venmo",
      "revolut",
      "cashapp",
      "wise",
      "mercadopago",
      "zelle",
      "monzo",
      "paypal",
      "upi",
      "xmoney",
      "monobank",
    ],
    predecessorRiskWindows: { paypal: "1209600", venmo: "1209600" },
    predecessorControllerChangeDelay: "172800",
    allowedWhitelistPolicyOwners: [
      "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
      "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    ],
  },
  base_staging: {
    chainId: 8453,
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    stakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    escrow: "0x77e8f808FE201075e0bD651CD46fdF239fc83265",
    unifiedPaymentVerifierV3: {
      address: "0x4c62E99649c8Ba745E67018f5c8a483D77c429C4",
      runtimeCodeHash:
        "0x3125872c0996c6d79fc3ed080a1b85b0f6eeb1fd51d1003d517ea3053af5a8fa",
    },
    paymentVerifierRegistry: {
      address: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
      runtimeCodeHash:
        "0xf8b2a3d222990397e047e7e4f1afe45ecfabe0a9d04be7b5e97e5a1755026e36",
    },
    disputeVerifier: {
      address: "0x973578148c5Fd49b9f68B50B26066555325AC708",
      runtimeCodeHash:
        "0xb3b34734cfd162cd129d0c84285461c751321545213ec20164745b8e72f9dd6c",
    },
    disputeNullifierRegistry: {
      address: "0xE0B05a9655AF0f31E32904267baa50FbC7f217ea",
      runtimeCodeHash:
        "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
    },
    whitelistPolicy: {
      address: "0xF79aAD1BAaB617fF3Eb299225c80893F22F743Fe",
      runtimeCodeHash:
        "0x1ece96bb7be9cdd2433a2aad66c9b2d710e3e210a65876e0f8c1e43662ee5653",
    },
    predecessorVault: {
      address: "0x92d7B59E99e1CD2066540Cd2413b8714948b731f",
      runtimeCodeHash:
        "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
    },
    predecessorPolicy: {
      address: "0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c",
      runtimeCodeHash:
        "0x70c43bfae8253a6a166f9697ddc27b2d77b4d9841e01fefc2db84037d9a98622",
    },
    predecessorHook: {
      address: "0x5A7f6cb7397134da1fDEFA7E2D434b4Cf18E56D9",
      runtimeCodeHash:
        "0xb9ce42108c706f9241aeb41ffdc0da6b7584e8482183055452098b2f16c7abfd",
    },
    // The predecessor policy, then the retired relayer-bypass and first-O4 policies.
    retainedDisputeWriters: [
      "0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c",
      "0x1a9C442E3Ae99fB08313242fCdA601431027B39C",
      "0x9dfB75e0ef06Bf757176c5bE3C9537c6ccdB5215",
    ],
    allowMultipleIntents: false,
    // Live registry order; it differs from lane 31's ratified staging order. Lane 46 preserves it.
    paymentMethods: [
      "upi",
      "zelle",
      "monzo",
      "alipay",
      "chime",
      "venmo",
      "revolut",
      "cashapp",
      "wise",
      "mercadopago",
      "paypal",
      "monobank",
      "mercury",
      "xmoney",
    ],
    predecessorRiskWindows: { paypal: "1209600", venmo: "1209600" },
    predecessorControllerChangeDelay: "172800",
    allowedWhitelistPolicyOwners: [
      "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    ],
  },
};

export function isO4LiveNetwork(network: string): network is O4Network {
  return network === "base" || network === "base_staging";
}

export function expectedPaymentMethodCurrencies(name: string): string[] {
  if (
    !Object.prototype.hasOwnProperty.call(
      RATIFIED_PAYMENT_METHOD_CURRENCIES,
      name
    )
  ) {
    throw new Error(`Unknown payment method ${name}`);
  }
  return RATIFIED_PAYMENT_METHOD_CURRENCIES[name];
}

export function paymentMethodHash(name: string): string {
  return utils.keccak256(utils.toUtf8Bytes(name));
}

function deploymentSteps(network: O4Network): string[] {
  return [
    "deploy-vault",
    "deploy-whitelist",
    "deploy-policy",
    "authorize-controller",
    "deploy-verifier",
    ...O4_EXPECTED_LIVE[network].paymentMethods.map(
      (method) => `add-verifier-method:${method}`
    ),
    "deploy-orchestrator",
    "set-orchestrator-policy",
    ...(O4_EXPECTED_LIVE[network].allowMultipleIntents
      ? ["set-allow-multiple-intents"]
      : []),
  ];
}

export const LANE_45_STEP_KINDS: Record<O4Network, readonly string[]> = {
  base_staging: deploymentSteps("base_staging"),
  base: [
    ...deploymentSteps("base"),
    "transfer-vault-owner",
    "transfer-policy-owner",
    "transfer-whitelist-owner",
    "transfer-verifier-owner",
    "transfer-orchestrator-owner",
  ],
};

export function classifyLane45Prefix(
  network: O4Network,
  completed: readonly boolean[]
): { phase: "absent" | "partial" | "prepared"; nextStep: number | null } {
  if (completed.length !== LANE_45_STEP_KINDS[network].length) {
    throw new Error(`Deploy-only state length mismatch for ${network}`);
  }
  const firstMissing = completed.indexOf(false);
  if (firstMissing >= 0 && completed.slice(firstMissing + 1).some(Boolean)) {
    throw new Error("Deploy-only state is not a contiguous prefix");
  }
  if (firstMissing === -1) return { phase: "prepared", nextStep: null };
  return {
    phase: firstMissing === 0 ? "absent" : "partial",
    nextStep: firstMissing,
  };
}
