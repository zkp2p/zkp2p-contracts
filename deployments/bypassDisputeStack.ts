import { utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "hardhat-deploy/types";
import {
  assertCanonicalDeployment,
  assertDeploymentMatchesChain,
} from "./canonicalDeployment";
import { DISPUTABLE_PAYMENT_METHODS } from "./parameters";
import { RATIFIED_PAYMENT_METHOD_CURRENCIES } from "../deploy/31_deploy_v3_payment_binding_stack";

export type BypassNetwork = "base" | "base_staging";
export const LANE_45_TAG = "45_deploy_bypass_dispute_stack";
export const LANE_46_TAG = "46_activate_bypass_dispute_stack";

// Record order follows the resumable deployment steps, not the artifact table.
export const BYPASS_DEPLOYMENT_NAMES = [
  "StakeVaultCascade",
  "CascadeDisputeProtectionPolicy",
  "IntentLifecycleHookV2",
  "UnifiedPaymentVerifierV4",
  "OrchestratorV4",
] as const;
export type BypassDeploymentName = (typeof BYPASS_DEPLOYMENT_NAMES)[number];
export const BYPASS_ARTIFACT_NAMES: Record<BypassDeploymentName, string> = {
  StakeVaultCascade: "StakeVault",
  CascadeDisputeProtectionPolicy: "CascadeDisputeProtectionPolicy",
  IntentLifecycleHookV2: "IntentLifecycleHookV2",
  UnifiedPaymentVerifierV4: "UnifiedPaymentVerifierV4",
  OrchestratorV4: "OrchestratorV4",
};
/** Recorded after execution; Base is added by its own recording PR after
 * lane 45 runs there. */
export const BYPASS_RECORDED_DEPLOYMENTS: Partial<
  Record<
    BypassNetwork,
    Record<BypassDeploymentName, { address: string; runtimeCodeHash: string }>
  >
> = {};

export const BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS = {
  StakeVaultBypass: {
    address: "0x6b32df91EB92637F64bA444996702fC9582C87a1",
    runtimeCodeHash:
      "0x3ce00cf0a7e325a116e87ea330c8997b94df705e4e0653d3de9484fca614356e",
  },
  DisputeProtectionPolicyBypass: {
    address: "0x1a9C442E3Ae99fB08313242fCdA601431027B39C",
    runtimeCodeHash:
      "0x496cfd95e23692cb7e282cfe7911797d16056b973d2bacfb44ff30c179c719e0",
  },
  IntentLifecycleHookV1Bypass: {
    address: "0xec27Cc47370267c843177375c3Fe43D29D498bB4",
    runtimeCodeHash:
      "0x42574848f3e7e0bda80a2715bbe10a6317134211e4de6c2455baaed4ef792f61",
  },
  UnifiedPaymentVerifierV4: {
    address: "0x3fe38Afdfa85A9E14D9b0ae5A5B2E577A8a71DA7",
    runtimeCodeHash:
      "0xd4492805a7f86aca9419a84156f4ffe64bdc2f82854f83e7d17c0e5f79049a5c",
  },
};

export const BYPASS_PAYMENT_BINDING_RECORDED: Record<BypassNetwork, boolean> = {
  base: false,
  base_staging: true,
};

export function isSupersededStagingRecord(
  network: string,
  name: string,
  address: string
): boolean {
  return (
    network === "base_staging" &&
    name === "UnifiedPaymentVerifierV4" &&
    address.toLowerCase() ===
      BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.UnifiedPaymentVerifierV4.address.toLowerCase()
  );
}

/** A record's solcInputHash depends on the deploying checkout's build cache
 * history, so it cannot gate later verification from a clean build. Recorded
 * deployments use address and runtime pins; unrecorded ones stay canonical. */
export async function assertBypassDeploymentRecord(
  hre: HardhatRuntimeEnvironment,
  network: string,
  name: BypassDeploymentName,
  record: Deployment,
  blockTag?: string | number
): Promise<void> {
  if (isSupersededStagingRecord(network, name, record.address)) {
    throw new Error(
      `${name} is the superseded staging deployment; run lane 45`
    );
  }
  await assertDeploymentMatchesChain(
    hre,
    record,
    name,
    BYPASS_ARTIFACT_NAMES[name],
    blockTag
  );
  const pin = isBypassLiveNetwork(network)
    ? BYPASS_RECORDED_DEPLOYMENTS[network]?.[name]
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
      BYPASS_ARTIFACT_NAMES[name],
      blockTag
    );
  }
}

export function supersededBypassLifecycleHookRuntimeHash(
  network: string,
  address: string
): string | undefined {
  const pin =
    network === "base_staging"
      ? BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.IntentLifecycleHookV1Bypass
      : undefined;
  return pin && address.toLowerCase() === pin.address.toLowerCase()
    ? pin.runtimeCodeHash
    : undefined;
}

export const BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY = 0;
export const BYPASS_PREDECESSOR_DEPLOYMENT_NAMES = {
  vault: "StakeVaultMethodScoped",
  policy: "DisputeProtectionPolicyMethodScopedStaked",
  hook: "IntentLifecycleHookV1MethodScopedStaked",
} as const;

export type ContractPin = { address: string; runtimeCodeHash: string };
export type BypassLivePins = {
  retiredVerifier: ContractPin;
  initialO3Hook: ContractPin;
  retainedDisputeWriters: string[];
  allowMultipleIntents: boolean;
  chainId: number;
  deployer: string;
  stakeToken: string;
  governance: string;
  escrow: string;
  unifiedPaymentVerifierV3: ContractPin;
  paymentVerifierRegistry: ContractPin;
  disputeVerifier: ContractPin;
  disputeNullifierRegistry: ContractPin;
  whitelistPolicy: ContractPin;
  predecessorVault: ContractPin;
  // O3 August stack trust pin only; cascade opt-outs are independent.
  predecessorPolicy: ContractPin;
  predecessorHook: ContractPin;
  paymentMethods: string[];
  riskWindows: Record<string, string>;
  predecessorControllerChangeDelay: string;
  allowedWhitelistPolicyOwners: string[];
};

export const BYPASS_EXPECTED_LIVE: Record<BypassNetwork, BypassLivePins> = {
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
    retiredVerifier: {
      address: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
      runtimeCodeHash:
        "0x7636c79f0f46cf88c7122767e553264f1898fa253ea214f6a1c3187b0f0a4bcf",
    },
    initialO3Hook: {
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
    riskWindows: { paypal: "1209600", venmo: "1209600" },
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
    retiredVerifier:
      BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.UnifiedPaymentVerifierV4,
    initialO3Hook:
      BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.IntentLifecycleHookV1Bypass,
    retainedDisputeWriters: [
      "0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c",
      BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.DisputeProtectionPolicyBypass
        .address,
    ],
    allowMultipleIntents: false,
    paymentMethods: [
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
      "upi",
      "xmoney",
    ],
    riskWindows: { paypal: "1209600", venmo: "1209600" },
    predecessorControllerChangeDelay: "172800",
    allowedWhitelistPolicyOwners: [
      "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    ],
  },
};

export function isBypassLiveNetwork(network: string): network is BypassNetwork {
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

function deploymentSteps(network: BypassNetwork): string[] {
  const riskWindowMethods = Object.keys(
    BYPASS_EXPECTED_LIVE[network].riskWindows
  );
  if (
    riskWindowMethods.length !== DISPUTABLE_PAYMENT_METHODS.length ||
    !DISPUTABLE_PAYMENT_METHODS.every((method) =>
      riskWindowMethods.includes(method)
    )
  ) {
    throw new Error(`Pinned risk window methods mismatch for ${network}`);
  }
  riskWindowMethods.sort(
    (a, b) =>
      DISPUTABLE_PAYMENT_METHODS.indexOf(a) -
      DISPUTABLE_PAYMENT_METHODS.indexOf(b)
  );
  return [
    "deploy-vault",
    "deploy-policy",
    "initialize-controller",
    "deploy-hook",
    "authorize-hook",
    ...riskWindowMethods.map((method) => `set-risk-window:${method}`),
    "deploy-verifier",
    ...BYPASS_EXPECTED_LIVE[network].paymentMethods.map(
      (method) => `add-verifier-method:${method}`
    ),
    "deploy-orchestrator",
    "set-orchestrator-hook",
    ...(BYPASS_EXPECTED_LIVE[network].allowMultipleIntents
      ? ["set-allow-multiple-intents"]
      : []),
  ];
}

export const LANE_45_STEP_KINDS: Record<BypassNetwork, readonly string[]> = {
  base_staging: deploymentSteps("base_staging"),
  base: [
    ...deploymentSteps("base"),
    "transfer-vault-owner",
    "transfer-policy-owner",
    "transfer-verifier-owner",
    "transfer-orchestrator-owner",
  ],
};

export function classifyLane45Prefix(
  network: BypassNetwork,
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
