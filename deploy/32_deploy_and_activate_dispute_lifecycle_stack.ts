import { ethers } from "ethers";

type HistoricalRuntimeEnvironment = {
  deployments: {
    getNetworkName(): string;
    get(name: string): Promise<{ address: string; deployedBytecode?: string }>;
  };
  ethers: {
    provider: {
      getCode(address: string): Promise<string>;
    };
  };
};

type HistoricalDeployFunction = {
  (hre: HistoricalRuntimeEnvironment): Promise<void>;
  skip(hre: HistoricalRuntimeEnvironment): Promise<boolean>;
  dependencies: string[];
  tags: string[];
};

type HistoricalContractEvidence = {
  address: string;
  deploymentBytecodeHash: string;
  runtimeCodeHash: string;
};

type HistoricalDisputeStack = {
  activeLifecycleHook: Omit<HistoricalContractEvidence, "deploymentBytecodeHash">;
  contracts: Record<string, HistoricalContractEvidence>;
};

export const PREDECESSOR_DISPUTE_STACKS: Record<string, HistoricalDisputeStack> = {
  base: {
    activeLifecycleHook: {
      address: "0x251d78fb6bBb4071995Bce74bAfC9E4168638622",
      runtimeCodeHash: "0x03d02863ed5eaa096d4089cb1e126681c0621d99409124f4af5be7ed83e341fe",
    },
    contracts: {
      StakeVault: {
        address: "0x8B8e853f47e6e0d3944e3689197B35216933dDea",
        deploymentBytecodeHash: "0x3ceac244f2d721614975457b041e95f661feba8ef6bbfc73c23b55aaac27d3e6",
        runtimeCodeHash: "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
      },
      DisputeProtectionPolicy: {
        address: "0xc086b6120B5e61EF48221E6A78c69737c9948dF9",
        deploymentBytecodeHash: "0x6146f8eb152848ddfd40d67a152a44230ed783b6c1e768d023b88fc2a09cb38f",
        runtimeCodeHash: "0xf08bce9ad622b9d45ce310493627cbef3bf6c4ac915661d5bc572bb59b61e084",
      },
      IntentLifecycleHookV1: {
        address: "0x5B0017FCA6A2131701ef718e470a3930c1b6C12c",
        deploymentBytecodeHash: "0xad298e1829958f431833bf1c0e53311f27e95dd29806c4d55aa75163e6dbcc21",
        runtimeCodeHash: "0xff9db07ce83908b7cedb31f8c085004aa78c91bb86e0565f11fad3e4bc36c5cb",
      },
      DisputeVerifier: {
        address: "0x30d4947f005653637005eed991005119D9eB2f34",
        deploymentBytecodeHash: "0x7aae03ea4bd5bc953dc87b7a272ef967dc093a71b39417f4b7bd88f46210e876",
        runtimeCodeHash: "0x65246e11392befc33d92246cf3ac2467d1f338a8b73c6514b76fab0a70a01ead",
      },
      DisputeNullifierRegistry: {
        address: "0xA845615b5203F7a21321DdF5e3a1ca024D93a443",
        deploymentBytecodeHash: "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
        runtimeCodeHash: "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
      },
    },
  },
  base_staging: {
    activeLifecycleHook: {
      address: "0x19D9F0Fcb08C60D8bd0CD061C34eae27eF8b6e65",
      runtimeCodeHash: "0xba70239e37624f5808e2f79e100e83a17daeb1558f310543187f5d8a121ec367",
    },
    contracts: {
      StakeVault: {
        address: "0xEc9f801e2a9Cc22bdc217aD3BB1E3058d0668f43",
        deploymentBytecodeHash: "0x3ceac244f2d721614975457b041e95f661feba8ef6bbfc73c23b55aaac27d3e6",
        runtimeCodeHash: "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
      },
      DisputeProtectionPolicy: {
        address: "0x21517b7743E727ae47A66FafF93550B689c15020",
        deploymentBytecodeHash: "0x6146f8eb152848ddfd40d67a152a44230ed783b6c1e768d023b88fc2a09cb38f",
        runtimeCodeHash: "0x4e6617a94819ad15693289b173a9a66a78cfe1dd706f6b4fdc5a5f6ad6a32971",
      },
      IntentLifecycleHookV1: {
        address: "0x19D9F0Fcb08C60D8bd0CD061C34eae27eF8b6e65",
        deploymentBytecodeHash: "0xad298e1829958f431833bf1c0e53311f27e95dd29806c4d55aa75163e6dbcc21",
        runtimeCodeHash: "0xba70239e37624f5808e2f79e100e83a17daeb1558f310543187f5d8a121ec367",
      },
      DisputeVerifier: {
        address: "0x973578148c5Fd49b9f68B50B26066555325AC708",
        deploymentBytecodeHash: "0x7aae03ea4bd5bc953dc87b7a272ef967dc093a71b39417f4b7bd88f46210e876",
        runtimeCodeHash: "0xb3b34734cfd162cd129d0c84285461c751321545213ec20164745b8e72f9dd6c",
      },
      DisputeNullifierRegistry: {
        address: "0xE0B05a9655AF0f31E32904267baa50FbC7f217ea",
        deploymentBytecodeHash: "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
        runtimeCodeHash: "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
      },
    },
  },
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export async function assertHistoricalDisputeStack(hre: HistoricalRuntimeEnvironment): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (network === "localhost" || network === "hardhat") return;

  const expectedStack = PREDECESSOR_DISPUTE_STACKS[network];
  if (!expectedStack) return;

  for (const [name, expected] of Object.entries(expectedStack.contracts)) {
    let deployment;
    try {
      deployment = await hre.deployments.get(name);
    } catch {
      throw new Error(`Missing predecessor deployment ${name} on ${network}`);
    }
    if (!sameAddress(deployment.address, expected.address)) {
      throw new Error(`${name} predecessor address mismatch on ${network}`);
    }
    if (
      typeof deployment.deployedBytecode !== "string" ||
      ethers.utils.keccak256(deployment.deployedBytecode) !== expected.deploymentBytecodeHash
    ) {
      throw new Error(`${name} predecessor deployment bytecode hash mismatch on ${network}`);
    }
    const runtimeCode = await hre.ethers.provider.getCode(expected.address);
    if (runtimeCode === "0x" || ethers.utils.keccak256(runtimeCode) !== expected.runtimeCodeHash) {
      throw new Error(`${name} predecessor runtime bytecode hash mismatch on ${network}`);
    }
  }
}

const func = (async function (hre: HistoricalRuntimeEnvironment): Promise<void> {
  await assertHistoricalDisputeStack(hre);
  console.log("Lane 32 is immutable predecessor evidence; lane 34 owns the opt-in successor stack.");
}) as HistoricalDeployFunction;

func.skip = async (hre: HistoricalRuntimeEnvironment): Promise<boolean> => {
  await assertHistoricalDisputeStack(hre);
  return true;
};

func.tags = ["32_historical_dispute_lifecycle_stack"];
func.dependencies = [];

export default func;
