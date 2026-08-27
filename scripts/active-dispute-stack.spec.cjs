#!/usr/bin/env node

require(require.resolve("ts-node/register/transpile-only"));

const assert = require("node:assert/strict");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const {
  INTERNAL_POLICY_RECORDS,
  getActiveDisputeDeploymentName,
  getActiveDisputeSelectionStamp,
  normalizeDisputeNetworkName,
  resolveActiveDisputeAliases,
} = require("../deployments/activeDisputeStack.cjs");
const {
  canonicalizeDeploymentOutput,
  serializeDeploymentOutput,
} = require("./canonicalizeDeploymentOutput.ts");
const {
  extractAddresses,
  resolveAddressOutputContracts,
} = require("../packages/contracts/scripts/extractors/addresses.ts");
const {
  resolveAbiOutputContracts,
} = require("../packages/contracts/scripts/extractors/abis.ts");
const { extractAll } = require("../packages/contracts/scripts/extract-all.ts");

const ABI = [{ type: "function", name: "owner", inputs: [], outputs: [] }];

/**
 * @param {string} address
 * @param {unknown[]} abi
 */
function deployment(address, abi = ABI) {
  return { address, abi };
}

/** @returns {Record<string, { address: string, abi: unknown[] }>} */
function contracts() {
  return {
    OtherContract: deployment("0x0000000000000000000000000000000000000001", []),
    StakeVault: deployment("0x0000000000000000000000000000000000000011"),
    DisputeProtectionPolicy: deployment(
      "0x0000000000000000000000000000000000000012"
    ),
    IntentLifecycleHookV1: deployment(
      "0x0000000000000000000000000000000000000013"
    ),
    StakeVaultOptIn: deployment("0x0000000000000000000000000000000000000021"),
    DisputeProtectionPolicyOptIn: deployment(
      "0x0000000000000000000000000000000000000022"
    ),
    IntentLifecycleHookV1OptIn: deployment(
      "0x0000000000000000000000000000000000000023"
    ),
    StakeVaultMethodScoped: deployment(
      "0x0000000000000000000000000000000000000031"
    ),
    DisputeProtectionPolicyMethodScoped: deployment(
      "0x0000000000000000000000000000000000000032"
    ),
    IntentLifecycleHookV1MethodScoped: deployment(
      "0x0000000000000000000000000000000000000033"
    ),
    DisputeProtectionPolicyMethodScopedStaked: deployment(
      "0x0000000000000000000000000000000000000034"
    ),
    IntentLifecycleHookV1MethodScopedStaked: deployment(
      "0x0000000000000000000000000000000000000035"
    ),
    WhitelistPolicy: deployment("0x0000000000000000000000000000000000000041"),
    WhitelistPolicyMethodScoped: deployment(
      "0x0000000000000000000000000000000000000042"
    ),
  };
}

test("strips passive internal policy records on every supported network", () => {
  assert.deepEqual(INTERNAL_POLICY_RECORDS, [
    "WhitelistPolicyMethodScoped",
    "DisputeProtectionPolicyMethodScoped",
    "IntentLifecycleHookV1MethodScoped",
    "StakeVaultMethodScoped",
    "DisputeProtectionPolicyMethodScopedStaked",
    "IntentLifecycleHookV1MethodScopedStaked",
  ]);
  for (const network of ["base", "base_staging", "localhost", "hardhat"]) {
    const resolved = resolveActiveDisputeAliases(network, contracts());
    for (const internalName of INTERNAL_POLICY_RECORDS) {
      assert.equal(
        internalName in resolved,
        false,
        `${network}:${internalName}`
      );
    }
    assert.equal("WhitelistPolicy" in resolved, true, network);
    assert.equal(
      resolved.WhitelistPolicy.address,
      contracts().WhitelistPolicyMethodScoped.address,
      network
    );
  }
});

test("normalizes Hardhat and package network names through one boundary", () => {
  assert.equal(normalizeDisputeNetworkName("base_staging"), "base_staging");
  assert.equal(normalizeDisputeNetworkName("baseStaging"), "base_staging");
  assert.equal(normalizeDisputeNetworkName("base"), "base");
  assert.equal(normalizeDisputeNetworkName("localhost"), "localhost");
  assert.equal(normalizeDisputeNetworkName("hardhat"), "hardhat");
  assert.throws(
    () => normalizeDisputeNetworkName("sepolia"),
    /Unsupported dispute stack network/
  );
});

test("resolves successor records on live networks after the passive deployment", () => {
  assert.deepEqual(resolveActiveDisputeAliases("base", contracts()), {
    OtherContract: deployment("0x0000000000000000000000000000000000000001", []),
    StakeVault: deployment("0x0000000000000000000000000000000000000031"),
    DisputeProtectionPolicy: deployment(
      "0x0000000000000000000000000000000000000034"
    ),
    IntentLifecycleHookV1: deployment(
      "0x0000000000000000000000000000000000000035"
    ),
    WhitelistPolicy: deployment("0x0000000000000000000000000000000000000042"),
  });
  assert.equal(
    resolveActiveDisputeAliases("base_staging", contracts()).StakeVault.address,
    "0x0000000000000000000000000000000000000031"
  );
});

test("resolves successor records locally and removes every internal deployment key", () => {
  const resolved = resolveActiveDisputeAliases("hardhat", contracts());

  assert.equal(
    resolved.StakeVault.address,
    "0x0000000000000000000000000000000000000031"
  );
  assert.equal(
    resolved.DisputeProtectionPolicy.address,
    "0x0000000000000000000000000000000000000034"
  );
  assert.equal(
    resolved.IntentLifecycleHookV1.address,
    "0x0000000000000000000000000000000000000035"
  );
  assert.equal(
    resolved.WhitelistPolicy.address,
    "0x0000000000000000000000000000000000000042"
  );
  assert.equal(
    Object.keys(resolved).some((name) => name.endsWith("OptIn")),
    false
  );
  assert.equal(
    Object.keys(resolved).some((name) => name.includes("MethodScoped")),
    false
  );
});

test("returns only known canonical deployment names", () => {
  assert.equal(
    getActiveDisputeDeploymentName("base", "StakeVault"),
    "StakeVaultMethodScoped"
  );
  assert.equal(
    getActiveDisputeDeploymentName("base", "WhitelistPolicy"),
    "WhitelistPolicyMethodScoped"
  );
  assert.equal(
    getActiveDisputeDeploymentName("hardhat", "StakeVault"),
    "StakeVaultMethodScoped"
  );
  assert.throws(
    () => getActiveDisputeDeploymentName("base", "UnknownPolicy"),
    /Unknown canonical dispute deployment/
  );
});

test("fails closed on missing records and lets the selected hard cut replace a legacy ABI", () => {
  const missing = contracts();
  delete missing.StakeVaultMethodScoped;
  assert.throws(
    () => resolveActiveDisputeAliases("localhost", missing),
    /Missing active dispute deployment/
  );

  const drifted = contracts();
  drifted.StakeVault.abi = [
    { type: "function", name: "different", inputs: [], outputs: [] },
  ];
  assert.deepEqual(
    resolveActiveDisputeAliases("localhost", drifted).StakeVault.abi,
    contracts().StakeVaultMethodScoped.abi
  );
});

test("does not mutate its input or expose one internal record twice", () => {
  const input = contracts();
  const snapshot = structuredClone(input);
  const resolved = resolveActiveDisputeAliases("localhost", input);

  assert.deepEqual(input, snapshot);
  const exposedAddresses = [
    resolved.StakeVault.address,
    resolved.DisputeProtectionPolicy.address,
    resolved.IntentLifecycleHookV1.address,
  ];
  assert.equal(new Set(exposedAddresses).size, exposedAddresses.length);
});

test("every deployment/package consumer exposes only canonical aliases", () => {
  const input = contracts();
  const consumers =
    /** @type {Array<(value: ReturnType<typeof contracts>) => ReturnType<typeof contracts>>} */ ([
      (value) => resolveActiveDisputeAliases("hardhat", value),
      (value) => resolveAddressOutputContracts("hardhat", value),
      (value) => resolveAbiOutputContracts("hardhat", value),
    ]);
  for (const resolveContracts of consumers) {
    const resolved = resolveContracts(input);
    assert.equal(
      resolved.StakeVault.address,
      input.StakeVaultMethodScoped.address
    );
    assert.equal(
      resolved.DisputeProtectionPolicy.address,
      input.DisputeProtectionPolicyMethodScopedStaked.address
    );
    assert.equal(
      resolved.IntentLifecycleHookV1.address,
      input.IntentLifecycleHookV1MethodScopedStaked.address
    );
    assert.equal(
      resolved.WhitelistPolicy.address,
      input.WhitelistPolicyMethodScoped.address
    );
    assert.equal(
      Object.keys(resolved).some((name) => name.endsWith("OptIn")),
      false
    );
    assert.equal(
      Object.keys(resolved).some((name) => name.includes("MethodScoped")),
      false
    );
  }
});

test("accepts only a currently stamped canonical successor output", () => {
  const canonical = /** @type {ReturnType<typeof contracts>} */ (
    resolveActiveDisputeAliases("localhost", contracts())
  );
  const stamp = getActiveDisputeSelectionStamp("localhost");
  const consumers =
    /** @type {Array<(value: ReturnType<typeof contracts>) => ReturnType<typeof contracts>>} */ ([
      (value) => resolveActiveDisputeAliases("localhost", value, stamp),
      (value) => resolveAddressOutputContracts("localhost", value, stamp),
      (value) => resolveAbiOutputContracts("localhost", value, stamp),
    ]);

  for (const resolveContracts of consumers) {
    assert.deepEqual(resolveContracts(canonical), canonical);
  }
  assert.throws(
    () => resolveActiveDisputeAliases("localhost", canonical),
    /Missing active dispute deployment/
  );
  assert.throws(
    () =>
      resolveActiveDisputeAliases("localhost", canonical, {
        ...stamp,
        selectionHash: "0".repeat(64),
      }),
    /selection stamp mismatch/
  );
});

test("address extraction preserves the exact active dispute selection stamp", async () => {
  await extractAddresses();

  for (const [packageNetwork, manifestNetwork] of [
    ["base", "base"],
    ["baseStaging", "base_staging"],
  ]) {
    const addresses = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "..",
          "packages",
          "contracts",
          "addresses",
          `${packageNetwork}.json`
        ),
        "utf8"
      )
    );
    assert.deepEqual(
      addresses.activeDisputeStack,
      getActiveDisputeSelectionStamp(manifestNetwork)
    );
  }
});

const BASE_RISK_WINDOWS = {
  "0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d":
    "1209600",
  "0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f":
    "1209600",
  "0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5": "0",
  "0x5908bb0c9b87763ac6171d4104847667e7f02b4c47b574fe890c1f439ed128bb": "0",
  "0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d": "0",
  "0x62c7ed738ad3e7618111348af32691b5767777fbaf46a2d8943237625552645c": "0",
  "0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268":
    "1209600",
  "0xa5418819c024239299ea32e09defae8ec412c03e58f5c75f1b2fe84c857f5483": "0",
  "0xcac9daea62d7b89d75ac73af4ee14dcf25721012ae82b568c2ea5c808eaa04ff": "0",
  "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3": "0",
};
const RISK_WINDOWS_BY_NETWORK = {
  base: BASE_RISK_WINDOWS,
  baseStaging: {
    ...BASE_RISK_WINDOWS,
    "0x1d966dbd6aeb8674d7c05174bd0ded7b56a798672bfb862ef20bbe8c2bbfce18": "0",
    "0xf81480907d808d639ad3230869e4b05a3b01b2d34e323af40f2efab807effd32": "0",
  },
};

const DISPUTE_STACK_BY_NETWORK = {
  base: {
    riskWindows: RISK_WINDOWS_BY_NETWORK.base,
    governanceOwner: "0x0bC26FF515411396DD588Abd6Ef6846E04470227",
    orchestratorAuthorizationFromBlock: "42878566",
    policyDeploymentBlock: "50537204",
    allowMultipleIntents: true,
    attestationWitnesses: [
      "0xDB4Ed7FAF170F0f6493E3adaaCaaFaF47092c754",
      "0xE078D93bFdd87A8c5C5cCA5905DCbA0Dd7A1F0BD",
    ],
    selectionHash:
      "ba40c2954b408d0c658881a8d28e5bfcc9bade5cc3d953fd17eae1eca69d841c",
    runtimeIdentities: {
      Orchestrator: {
        address: "0x88888883Ed048FF0a415271B28b2F52d431810D0",
        runtimeCodeHash:
          "0xf511343f2903dd1877c490796cc9423fac66b162b59004d55e522046c1ceb050",
      },
      OrchestratorV2: {
        address: "0x888888359E981B5225CA48fbCdCeff702FC3b888",
        runtimeCodeHash:
          "0xcf70a08cc24fcc00799f9f365d0998abe37c718c93ee370a78d1ca06c60d01e0",
      },
      OrchestratorV3: {
        address: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
        runtimeCodeHash:
          "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
      },
      StakeVault: {
        address: "0x47c26258222e2f96424bD2B21bf173f0DA5034C7",
        runtimeCodeHash:
          "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
      },
      DisputeProtectionPolicy: {
        address: "0xbF4B769dB70DBEc89b6b2c44988304a7aD2de4Fc",
        runtimeCodeHash:
          "0xf5a7756f16556da69c91c55bdcffd9fd95cc8cbdb772699827ec4c66db136dfe",
      },
      IntentLifecycleHookV1: {
        address: "0x5Dd6C675a7406fE8C9f0D93394a36fd6e8c50031",
        runtimeCodeHash:
          "0x2b479a570ddea7a990f2cae8fa95eb3b8599fc8b367332b8dab92f7d0cebf7e0",
      },
      RecognizedPredecessorHook: {
        address: "0x71467dCac3B50eeED5A485aC6a70f27B1EAC1970",
        runtimeCodeHash:
          "0x35789014e608a248f3244b61210fa259fee3566c33f50fd0e3fa1f5ae22e370b",
      },
      RecognizedPredecessorPolicy: {
        address: "0xcEc48F7242eDBf02875BB4629115Bd927e1287aA",
        runtimeCodeHash:
          "0x9c4be279da216021183638eaef79ebf98db248472685e9ecd0de3f24a513a641",
      },
      OrchestratorRegistry: {
        address: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
        runtimeCodeHash:
          "0xf0d132d621ac03181a6fade6a93bd0968d33830c8bf393793236787e7978aee1",
      },
      WhitelistPolicy: {
        address: "0x389Cd9bA91FfFcd83d267B241E975541892759Ce",
        runtimeCodeHash:
          "0xa83d138a5b89d2fd2861702febc6333e542dcdc8994ee76c345dcbd22fe685a4",
      },
      DisputeVerifier: {
        address: "0x30d4947f005653637005eed991005119D9eB2f34",
        runtimeCodeHash:
          "0x65246e11392befc33d92246cf3ac2467d1f338a8b73c6514b76fab0a70a01ead",
      },
      DisputeNullifierRegistry: {
        address: "0xA845615b5203F7a21321DdF5e3a1ca024D93a443",
        runtimeCodeHash:
          "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
      },
      MultiAttestationVerifier: {
        address: "0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5",
        runtimeCodeHash:
          "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
      },
    },
    addressExpectations: {
      AddressGroupRegistry: "0x39F80118f9eB619135f116171b6Cb91D372C5AF2",
      EscrowRegistry: "0xeD0e847B101abc96E796260AC358e12BAa2f5B21",
      PaymentVerifierRegistry: "0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e",
      RelayerRegistry: "0xEbA979889a9c97382A92472fF3703786fF180083",
      NullifierRegistryV2: "0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB",
      StakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
  },
  baseStaging: {
    riskWindows: RISK_WINDOWS_BY_NETWORK.baseStaging,
    governanceOwner: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    orchestratorAuthorizationFromBlock: "42614859",
    policyDeploymentBlock: "50536390",
    allowMultipleIntents: false,
    attestationWitnesses: [
      "0x66649F896521b0fb487fE2077b4FBDA283d7f19a",
      "0x4ab950AE1e3326578Bf7e643a2031E858aBa2927",
    ],
    selectionHash:
      "6c49c1ce51eec594a22385c4efcab08aa9926b6b63a725e14a0027ec5d2f4fc9",
    runtimeIdentities: {
      Orchestrator: {
        address: "0xF9b9CD27Deea496B960b3cb5221b514705fCaF5e",
        runtimeCodeHash:
          "0xf511343f2903dd1877c490796cc9423fac66b162b59004d55e522046c1ceb050",
      },
      OrchestratorV2: {
        address: "0xc17a59227B136c45fAa153086a15EF87ED14bE00",
        runtimeCodeHash:
          "0xcf70a08cc24fcc00799f9f365d0998abe37c718c93ee370a78d1ca06c60d01e0",
      },
      OrchestratorV3: {
        address: "0x2b5E8Ab562e45fA89D73802605E145ED3E3EeF4f",
        runtimeCodeHash:
          "0x4e58f26129559301c017ff264b61dd2255ed2107593d308472ef32d07b8745e9",
      },
      StakeVault: {
        address: "0x92d7B59E99e1CD2066540Cd2413b8714948b731f",
        runtimeCodeHash:
          "0xfd8d2a910b9ac2c55675ae06d0504f9aac43b02b7022755cf229b571156c681d",
      },
      DisputeProtectionPolicy: {
        address: "0x484fA07F085eb66bb7C2b649Ea9d5894b2B6681c",
        runtimeCodeHash:
          "0x70c43bfae8253a6a166f9697ddc27b2d77b4d9841e01fefc2db84037d9a98622",
      },
      IntentLifecycleHookV1: {
        address: "0x5A7f6cb7397134da1fDEFA7E2D434b4Cf18E56D9",
        runtimeCodeHash:
          "0xb9ce42108c706f9241aeb41ffdc0da6b7584e8482183055452098b2f16c7abfd",
      },
      RecognizedPredecessorHook: {
        address: "0x19D9F0Fcb08C60D8bd0CD061C34eae27eF8b6e65",
        runtimeCodeHash:
          "0xba70239e37624f5808e2f79e100e83a17daeb1558f310543187f5d8a121ec367",
      },
      RecognizedPredecessorPolicy: {
        address: "0x21517b7743E727ae47A66FafF93550B689c15020",
        runtimeCodeHash:
          "0x4e6617a94819ad15693289b173a9a66a78cfe1dd706f6b4fdc5a5f6ad6a32971",
      },
      OrchestratorRegistry: {
        address: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
        runtimeCodeHash:
          "0xf0d132d621ac03181a6fade6a93bd0968d33830c8bf393793236787e7978aee1",
      },
      WhitelistPolicy: {
        address: "0xF79aAD1BAaB617fF3Eb299225c80893F22F743Fe",
        runtimeCodeHash:
          "0x1ece96bb7be9cdd2433a2aad66c9b2d710e3e210a65876e0f8c1e43662ee5653",
      },
      DisputeVerifier: {
        address: "0x973578148c5Fd49b9f68B50B26066555325AC708",
        runtimeCodeHash:
          "0xb3b34734cfd162cd129d0c84285461c751321545213ec20164745b8e72f9dd6c",
      },
      DisputeNullifierRegistry: {
        address: "0xE0B05a9655AF0f31E32904267baa50FbC7f217ea",
        runtimeCodeHash:
          "0x1a711749b7700142265363c9c184c195ac81a1415e2142aa84edcbf1cd88142a",
      },
      MultiAttestationVerifier: {
        address: "0x9855a39aC5975069632e91160d8712CBfF19e864",
        runtimeCodeHash:
          "0x828a5dae520d3eaed904dfed56994dc6e892eb6416b58ad952c079e220ef841a",
      },
    },
    addressExpectations: {
      AddressGroupRegistry: "0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D",
      EscrowRegistry: "0xc545f336eC77E69bf115729acCbf2e557A00ac91",
      PaymentVerifierRegistry: "0x2261416DA54C85f975C73FA56EF4D2D6b0aEF7Cc",
      RelayerRegistry: "0xB214650b424E6b5fdcB1259566eB7A512D8Bd25E",
      NullifierRegistryV2: "0x2eb43d6C7c7Ec4220Aa6B8735BC053824a71778C",
      StakeToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
  },
};

test("package extraction publishes the exact dispute stack manifest without internal deployment names", async () => {
  const disputeStackDirectory = join(
    __dirname,
    "..",
    "packages",
    "contracts",
    "disputeStack"
  );
  rmSync(disputeStackDirectory, { recursive: true, force: true });
  await extractAll();
  assert.equal(existsSync(disputeStackDirectory), true);

  for (const [network, expected] of Object.entries(DISPUTE_STACK_BY_NETWORK)) {
    const manifest = JSON.parse(
      readFileSync(join(disputeStackDirectory, `${network}.json`), "utf8")
    );
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.chainId, 8453);
    assert.deepEqual(manifest.activeDisputeStack, {
      version: 2,
      selectionHash: expected.selectionHash,
    });
    assert.deepEqual(manifest.runtimeIdentities, expected.runtimeIdentities);
    assert.deepEqual(
      manifest.addressExpectations,
      expected.addressExpectations
    );
    assert.deepEqual(manifest.expectedRelations, {
      activeLifecycleHook:
        expected.runtimeIdentities.IntentLifecycleHookV1.address,
      recognizedPredecessorPolicy:
        expected.runtimeIdentities.RecognizedPredecessorPolicy.address,
      registeredOrchestrator: expected.runtimeIdentities.OrchestratorV3.address,
      authorizedLifecycleHook:
        expected.runtimeIdentities.IntentLifecycleHookV1.address,
      disputeNullifierAuthorizedWriter:
        expected.runtimeIdentities.DisputeProtectionPolicy.address,
      orchestratorEscrowRegistry: expected.addressExpectations.EscrowRegistry,
      orchestratorPaymentVerifierRegistry:
        expected.addressExpectations.PaymentVerifierRegistry,
      orchestratorRelayerRegistry: expected.addressExpectations.RelayerRegistry,
      hookOrchestratorRegistry:
        expected.runtimeIdentities.OrchestratorRegistry.address,
      hookWhitelistPolicy: expected.runtimeIdentities.WhitelistPolicy.address,
      hookDisputeProtectionPolicy:
        expected.runtimeIdentities.DisputeProtectionPolicy.address,
      whitelistGroupRegistry: expected.addressExpectations.AddressGroupRegistry,
      whitelistEscrowRegistry: expected.addressExpectations.EscrowRegistry,
      whitelistOrchestratorRegistry:
        expected.runtimeIdentities.OrchestratorRegistry.address,
      policyStakeVault: expected.runtimeIdentities.StakeVault.address,
      policyDisputeVerifier: expected.runtimeIdentities.DisputeVerifier.address,
      policyDisputeNullifierRegistry:
        expected.runtimeIdentities.DisputeNullifierRegistry.address,
      disputeVerifierNullifierRegistry:
        expected.addressExpectations.NullifierRegistryV2,
      disputeVerifierAttestationVerifier:
        expected.runtimeIdentities.MultiAttestationVerifier.address,
      vaultController:
        expected.runtimeIdentities.DisputeProtectionPolicy.address,
      vaultStakeToken: expected.addressExpectations.StakeToken,
    });
    assert.deepEqual(manifest.expectedGovernance, {
      owner: expected.governanceOwner,
      governedRuntimeIdentities: [
        "OrchestratorRegistry",
        "OrchestratorV3",
        "StakeVault",
        "DisputeProtectionPolicy",
        "WhitelistPolicy",
        "DisputeVerifier",
        "DisputeNullifierRegistry",
        "MultiAttestationVerifier",
      ],
      pendingOwner: "0x0000000000000000000000000000000000000000",
      twoStepGovernedRuntimeIdentities: [
        "StakeVault",
        "DisputeProtectionPolicy",
        "DisputeVerifier",
      ],
    });
    assert.deepEqual(manifest.attestationTrust, {
      requiredSignatures: "1",
      witnesses: expected.attestationWitnesses,
    });
    assert.equal("activation" in manifest, false);
    assert.deepEqual(manifest.exactAuthorizationSets, {
      orchestratorAuthorizationFromBlock:
        expected.orchestratorAuthorizationFromBlock,
      authorizedOrchestrators: [
        expected.runtimeIdentities.Orchestrator.address,
        expected.runtimeIdentities.OrchestratorV2.address,
        expected.runtimeIdentities.OrchestratorV3.address,
      ],
      lifecycleHookAuthorizationFromBlock: expected.policyDeploymentBlock,
      authorizedLifecycleHooks: [
        expected.runtimeIdentities.IntentLifecycleHookV1.address,
      ],
      passiveDisputeNullifierWriters: [
        expected.runtimeIdentities.RecognizedPredecessorPolicy.address,
      ],
      activeDisputeNullifierWriters: [
        expected.runtimeIdentities.DisputeProtectionPolicy.address,
      ],
    });
    assert.deepEqual(
      manifest.riskWindowSecondsByPaymentMethod,
      expected.riskWindows
    );
    assert.deepEqual(manifest.sentinel, {
      escrow: "0x0000000000000000000000000000000000000001",
      depositId: "0",
      expected: false,
    });
    assert.deepEqual(manifest.prerequisites, {
      orchestratorPaused: false,
      admissionsPaused: false,
      allowMultipleIntents: expected.allowMultipleIntents,
      orchestratorRegistered: true,
      lifecycleHookAuthorized: true,
      disputeNullifierWriterAuthorized: true,
      vaultControllerActivated: true,
      vaultPendingController: "0x0000000000000000000000000000000000000000",
      vaultPendingControllerValidAt: "0",
      pendingCoverageMaturity: "18446744073709551615",
    });
    assert.equal(JSON.stringify(manifest).includes("OptIn"), false);
  }

  const declarations = readFileSync(
    join(disputeStackDirectory, "types.d.ts"),
    "utf8"
  );
  const riskWindowValues = new Set(
    Object.values(RISK_WINDOWS_BY_NETWORK).flatMap((windows) =>
      Object.values(windows)
    )
  );
  for (const seconds of riskWindowValues) {
    assert.equal(declarations.includes(`'${seconds}'`), true);
  }
  assert.match(declarations, /chainId: 8453;/);
  assert.doesNotMatch(declarations, /DisputeStackActivation|activation:/);
  for (const paymentMethodHash of Object.keys(
    RISK_WINDOWS_BY_NETWORK.baseStaging
  )) {
    assert.equal(declarations.includes(`'${paymentMethodHash}'`), true);
  }
  assert.equal(declarations.includes("OptIn"), false);
  assert.match(
    readFileSync(join(disputeStackDirectory, "base.d.ts"), "utf8"),
    /DisputeStackManifest<'base'>/
  );
  assert.match(
    readFileSync(join(disputeStackDirectory, "baseStaging.d.ts"), "utf8"),
    /DisputeStackManifest<'base_staging'>/
  );
  const indexDeclarations = readFileSync(
    join(disputeStackDirectory, "index.d.ts"),
    "utf8"
  );
  assert.match(indexDeclarations, /from ['"]\.\/base['"]/);
  assert.match(indexDeclarations, /from ['"]\.\/baseStaging['"]/);
  assert.doesNotMatch(indexDeclarations, /DisputeStackActivation/);
  assert.doesNotMatch(indexDeclarations, /\.json['"]/);
});

test("contracts package exposes the dispute stack manifest through public CJS, ESM, JSON, and type subpaths", () => {
  const packageJson = require("../packages/contracts/package.json");
  assert.equal(packageJson.files.includes("disputeStack"), true);
  assert.equal(packageJson.files.includes("disputeReadiness"), false);
  assert.deepEqual(packageJson.exports["./disputeStack"], {
    types: "./_types/disputeStack/index.d.ts",
    import: "./_esm/disputeStack/index.js",
    "react-native": "./_esm/disputeStack/index.js",
    require: "./_cjs/disputeStack/index.js",
    default: "./_esm/disputeStack/index.js",
  });
  assert.deepEqual(packageJson.exports["./disputeStack/*"], {
    types: "./_types/disputeStack/*.d.ts",
    import: "./_esm/disputeStack/*.js",
    "react-native": "./_esm/disputeStack/*.js",
    require: "./disputeStack/*.json",
    default: "./_esm/disputeStack/*.js",
  });
  assert.equal(
    packageJson.exports["./disputeStack/*.json"],
    "./disputeStack/*.json"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      packageJson.exports,
      "./disputeReadiness"
    ),
    false
  );
});

test("canonical deployment-output rewriting is deterministic and leaves deployment evidence untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "active-dispute-output-"));
  const outputPath = join(directory, "localhostContracts.ts");
  const historicalPath = join(directory, "StakeVaultOptIn.json");
  const output = {
    name: "localhost",
    chainId: "31337",
    contracts: contracts(),
  };
  const originalOutput = serializeDeploymentOutput(output);
  const historicalBytes = '{"address":"0x1234","receipt":{"blockNumber":7}}\n';
  try {
    writeFileSync(outputPath, originalOutput);
    writeFileSync(historicalPath, historicalBytes);
    canonicalizeDeploymentOutput("localhost", outputPath);
    const first = readFileSync(outputPath, "utf8");
    canonicalizeDeploymentOutput("localhost", outputPath);
    assert.equal(readFileSync(outputPath, "utf8"), first);
    assert.equal(readFileSync(historicalPath, "utf8"), historicalBytes);
    assert.equal(first.includes("StakeVaultOptIn"), false);
    assert.equal(first.includes("StakeVaultMethodScoped"), false);
    assert.match(
      first,
      new RegExp(inputAddressFor("StakeVaultMethodScoped"), "i")
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** @param {string} name */
function inputAddressFor(name) {
  return contracts()[name].address;
}
