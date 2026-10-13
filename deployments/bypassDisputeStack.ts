import { utils } from "ethers";
import { DISPUTABLE_PAYMENT_METHODS } from "./parameters";
import { RATIFIED_PAYMENT_METHOD_CURRENCIES } from "../deploy/31_deploy_v3_payment_binding_stack";

export type BypassNetwork = "base" | "base_staging";
export const LANE_45_TAG = "45_deploy_bypass_dispute_stack";
export const LANE_46_TAG = "46_activate_bypass_dispute_stack";

// Record order follows the resumable deployment steps, not the artifact table.
export const BYPASS_DEPLOYMENT_NAMES = [
  "StakeVaultBypass",
  "DisputeProtectionPolicyBypass",
  "IntentLifecycleHookV1Bypass",
  "UnifiedPaymentVerifierV4",
] as const;
export type BypassDeploymentName = (typeof BYPASS_DEPLOYMENT_NAMES)[number];
export const BYPASS_ARTIFACT_NAMES: Record<BypassDeploymentName, string> = {
  StakeVaultBypass: "StakeVault",
  DisputeProtectionPolicyBypass: "DisputeProtectionPolicy",
  IntentLifecycleHookV1Bypass: "IntentLifecycleHookV1",
  UnifiedPaymentVerifierV4: "UnifiedPaymentVerifierV4",
};
export const BYPASS_STAKE_VAULT_CONTROLLER_CHANGE_DELAY = 0;
export const BYPASS_PREDECESSOR_DEPLOYMENT_NAMES = {
  vault: "StakeVaultMethodScoped",
  policy: "DisputeProtectionPolicyMethodScopedStaked",
  hook: "IntentLifecycleHookV1MethodScopedStaked",
} as const;

type ContractPin = { address: string; runtimeCodeHash: string };
export type BypassLivePins = {
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
  ];
}

export const LANE_45_STEP_KINDS: Record<BypassNetwork, readonly string[]> = {
  base_staging: deploymentSteps("base_staging"),
  base: [
    ...deploymentSteps("base"),
    "transfer-vault-owner",
    "transfer-policy-owner",
    "transfer-verifier-owner",
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
